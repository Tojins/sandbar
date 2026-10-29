// The idle janitor's pure decisions (#205): which task runs, which paths it
// visits, where its rolling branch starts, and what its ending means. The
// runner (`janitor.ts`) does the I/O around them.
//
// - A task is eligible while its run starts this UTC day are below
//   `runsPerDay`, its pull request carries no `land`, and its ledger's hold
//   key no longer matches the current (rolling branch tip, source tip).
//   Among eligible tasks the oldest last start wins, then config order. The
//   budget is a count of starts, never tokens: usage is a report (#82).
// - The scope is the least recently visited units, never-visited first, ties
//   by path. Blobs that are empty or over 200 000 bytes are no candidates.
//   A `file` task takes files in that order up to `budgetChars` bytes, at
//   least one; a `directory` task takes the one directory least recently
//   visited.
// - The rolling branch starts fresh from the source tip when origin has
//   none, when its latest pull request (any state) is merged or closed, or
//   when the source already contains it: containment alone misses a squash
//   merge. Otherwise it continues from origin's tip. Either way the push
//   leases on the origin tip seen now, the empty string meaning the branch
//   must not exist, so a continued branch's lease is its tip.
// - A DONE run is `committed`; a NEEDS-INFO with nothing committed beyond
//   the base is `no-change`, the anchor's way of saying there was nothing to
//   do; QUOTA, CREDENTIAL and an exhausted HARD-ERROR are `failed`; every
//   other terminal is `rejected`, its cause the terminal type and machine
//   cause (#186's NEEDS-STACK-CHANGE as `stack-change`). Only a run that
//   looked at its scope counts as a visit.

import type { JanitorTask, JanitorTaskPrompt } from "./config.js";
import type { Terminal } from "./inner-loop.js";
import type { JanitorLedger } from "./janitor-ledger.js";
import { loadTemplate, render } from "./prompts.js";

const TASK_ANCHOR = loadTemplate("janitor-task");

export const JANITOR_MAX_BLOB_BYTES = 200_000;

export type JanitorOutcome = "committed" | "no-change" | "rejected" | "pre-empted" | "failed";

export const utcDay = (at: Date | string): string =>
  (typeof at === "string" ? at : at.toISOString()).slice(0, 10);

export const runsOnDay = (ledger: JanitorLedger, day: string): number =>
  ledger.starts.filter((start) => utcDay(start) === day).length;

// What a hold is judged against: origin's rolling branch tip, if any, and the
// source tip. A hold stands until either moves.
export const janitorHoldKey = (branchTip: string | null, sourceTip: string): string =>
  `${branchTip ?? "none"}..${sourceTip}`;

export function pickJanitorTask(args: {
  readonly tasks: readonly JanitorTask[];
  readonly ledgers: ReadonlyMap<string, JanitorLedger>;
  readonly today: string;
  readonly landLabelled: ReadonlySet<string>;
  readonly holdKeys: ReadonlyMap<string, string>;
}): JanitorTask | null {
  let best: { readonly task: JanitorTask; readonly lastStart: string } | null = null;
  for (const task of args.tasks) {
    const ledger = args.ledgers.get(task.name);
    if (ledger === undefined || args.landLabelled.has(task.name)) continue;
    if (runsOnDay(ledger, args.today) >= task.runsPerDay) continue;
    if (ledger.hold !== undefined && ledger.hold.key === args.holdKeys.get(task.name)) continue;
    const lastStart = ledger.starts.at(-1) ?? "";
    if (best === null || lastStart < best.lastStart) best = { task, lastStart };
  }
  return best?.task ?? null;
}

export type ScopeCandidate = { readonly path: string; readonly bytes: number };

const parentDirectory = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
};

// The scope units a task's candidate files make: the files, or their
// parent directories.
export function scopeUnits(
  files: readonly ScopeCandidate[],
  unit: JanitorTask["unit"],
): ReadonlyMap<string, number> {
  const units = new Map<string, number>();
  for (const file of files) {
    if (file.bytes === 0 || file.bytes > JANITOR_MAX_BLOB_BYTES) continue;
    const key = unit === "file" ? file.path : parentDirectory(file.path);
    units.set(key, (units.get(key) ?? 0) + file.bytes);
  }
  return units;
}

export function pickScope(args: {
  readonly files: readonly ScopeCandidate[];
  readonly unit: JanitorTask["unit"];
  readonly visits: Readonly<Record<string, string>>;
  readonly budgetChars: number;
}): readonly string[] {
  const ordered = [...scopeUnits(args.files, args.unit)].sort(([a], [b]) => {
    const va = args.visits[a] ?? "";
    const vb = args.visits[b] ?? "";
    if (va !== vb) return va < vb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (args.unit === "directory") return ordered.slice(0, 1).map(([dir]) => dir);
  const scope: string[] = [];
  let bytes = 0;
  for (const [path, size] of ordered) {
    if (scope.length > 0 && bytes + size > args.budgetChars) break;
    scope.push(path);
    bytes += size;
  }
  return scope;
}

export type LatestPullRequest = {
  readonly number: number;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly labels: readonly string[];
};

export type RollingBase = { readonly kind: "fresh" | "continue"; readonly lease: string };

export function decideRollingBase(args: {
  readonly originTip: string | null;
  readonly latestPr: LatestPullRequest | null;
  readonly containedInSource: boolean;
}): RollingBase {
  const lease = args.originTip ?? "";
  const retired = args.originTip === null || args.containedInSource ||
    args.latestPr?.state === "MERGED" || args.latestPr?.state === "CLOSED";
  return { kind: retired ? "fresh" : "continue", lease };
}

// What a run ended as: `committed` has nothing to say, every other outcome
// may name a cause.
export type JanitorEnding =
  | { readonly outcome: "committed" }
  | { readonly outcome: Exclude<JanitorOutcome, "committed">; readonly cause?: string };

// A provider's quota or credential error ends a run as the terminal of that name does.
export const providerFailure = (
  cause: "QUOTA" | "CREDENTIAL",
): { readonly outcome: "failed"; readonly cause: string } => ({ outcome: "failed", cause });

export function janitorOutcome(
  terminal: Terminal,
  commitsBeyondBase: number,
): JanitorEnding {
  switch (terminal.type) {
    case "DONE":
      return { outcome: "committed" };
    case "NEEDS-INFO":
      return commitsBeyondBase === 0
        ? { outcome: "no-change" }
        : { outcome: "rejected", cause: terminal.type };
    case "QUOTA":
    case "CREDENTIAL":
      return providerFailure(terminal.type);
    case "HARD-ERROR":
      return { outcome: "failed", cause: terminal.type };
    case "NEEDS-STACK-CHANGE":
      return { outcome: "rejected", cause: "stack-change" };
    case "NEEDS-UI-PROTOTYPE":
      return { outcome: "rejected", cause: terminal.type };
    case "NEEDS-HUMAN":
    case "NEEDS-HUMAN-REVIEW":
    case "NEEDS-PARTITION":
      return { outcome: "rejected", cause: `${terminal.type}: ${terminal.cause}` };
  }
}

export const visitCounts = (outcome: JanitorOutcome): boolean =>
  outcome === "committed" || outcome === "no-change" || outcome === "rejected";

// Where a task's prompt comes from: the repository file read at the source
// tip (null for the standards), and how a pull request body names it.
export function describePrompt(prompt: JanitorTaskPrompt): {
  readonly path: string | null;
  readonly label: string;
} {
  if (prompt === "standards") return { path: null, label: "the project standards flagged `{janitor}`" };
  if ("file" in prompt) return { path: prompt.file, label: `\`${prompt.file}\`` };
  return { path: `.claude/skills/${prompt.skill}/SKILL.md`, label: `the skill \`${prompt.skill}\`` };
}

// The `What to apply` section: the flagged standards groups, or the prompt
// file as the source tip has it.
export function janitorSourceText(
  prompt: JanitorTaskPrompt,
  text: string,
  sourceBranch: string,
): string {
  const { path } = describePrompt(prompt);
  return path === null
    ? `Find code in scope that breaks these project rules and fix it.\n\n${text}`
    : `From \`${path}\` on \`${sourceBranch}\`:\n\n${text}`;
}

export function renderTaskAnchor(args: {
  readonly task: string;
  readonly unit: JanitorTask["unit"];
  readonly scope: readonly string[];
  readonly source: string;
}): string {
  const scope = args.scope
    .map((path) => args.unit === "file" ? `- \`${path}\`` : `- \`${path}/\`, the files directly in it`)
    .join("\n");
  return render(TASK_ANCHOR, { task: args.task, scope, source: args.source });
}

// The rolling draft pull request: like a chunk's (`chunk-pr.ts`), its body
// names what the branch carries and makes no claim about mechanics.
export function janitorPrContent(
  task: string,
  prompt: JanitorTaskPrompt,
): { readonly title: string; readonly body: string } {
  return { title: `Idle task: ${task}`, body: `Idle task \`${task}\`, applying ${describePrompt(prompt).label}.` };
}

export const JANITOR_CONFLICT_PR_COMMENT = (args: {
  readonly branch: string;
  readonly sourceBranch: string;
}): string =>
  `${args.branch} no longer merges cleanly with ${args.sourceBranch}, so this ` +
  "idle task is held: no run until either branch moves. Resolve the conflict " +
  `on ${args.branch}, or close this pull request to start the task afresh.`;
