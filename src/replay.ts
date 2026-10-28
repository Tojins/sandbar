// Replay's pure layer (#195): the case file and the session manifest, and every
// decision about them that needs no I/O. `replay-run.ts` is the adapter and
// `replay-cli.ts` the human's entry point; nothing in the daemon imports any
// of the three (replay-boundary.test.ts).
//
// A CASE is one past issue as it stood when it was admitted: the commit its
// branch was cut from (`seedSha`, and where that came from), the issue JSON
// the roles read (`issueFrom`: the snapshot the admission filed, or a
// reconstruction from today's issue with only the comments made by the
// cutoff, flagged when the body was edited after it), and pointers to the
// original run and its landing. `parseReplayCases` is the one validation of a
// case file, and lists every violation rather than the first.
//
// A SESSION is one `replay run`: its manifest records what was compared (the
// driver, the per-role routing, the budgets, the case file's sha256) and one
// result per (repeat, case). The plan is repeat-major, so model drift during a
// session spreads across cases instead of landing on the last one. A case not
// run — because a quota or credential stop closed the session — says why, and
// a repeat whose record never started has no `run`.

import { type IssueComment, type IssueJson, issueJsonErrors } from "./issue-anchor.js";
import type { Terminal } from "./inner-loop.js";

export type DiffSize = {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
};

export type SeedFrom = "recorded" | "merge-base" | "manual";

export type CaseText =
  | { readonly issueFrom: "recorded" }
  | { readonly issueFrom: "reconstructed"; readonly editedAfterAdmission: boolean };

export type ReplayCase = CaseText & {
  readonly issue: number;
  readonly title: string;
  readonly seedSha: string;
  readonly seedFrom: SeedFrom;
  readonly issueJson: IssueJson;
  readonly original: { readonly logsDir: string; readonly run: string } | null;
  readonly landed: {
    readonly merge: string;
    readonly tip: string;
    readonly diff: DiffSize;
  } | null;
};

export type ReplayCases = {
  readonly replayCases: 1;
  // `owner/name`: the tracker the issues were frozen from.
  readonly repo: string;
  readonly sourceBranch: string;
  readonly cases: readonly ReplayCase[];
};

export type ReplayResult = {
  readonly repeat: number;
  readonly run: string | null;
  readonly issue: number;
  readonly seedSha: string;
  readonly branch: string;
} & (
  | {
      readonly status: "ran";
      readonly terminal: Terminal["type"];
      readonly tip: string;
      // The last gate-1 verdict, or null when no gate-1 ran.
      readonly lastGateOk: boolean | null;
      readonly diff: DiffSize;
    }
  | { readonly status: "not-run"; readonly reason: string }
);

export type RoleRouting = {
  readonly agent: string;
  readonly model: string;
  readonly effort: string | null;
};

export type ReplaySession = {
  readonly replaySession: 1;
  readonly label: string;
  readonly driver: string;
  readonly casesFile: string;
  readonly casesSha256: string;
  readonly repeats: number;
  readonly parallel: number;
  readonly routing: Readonly<Record<string, RoleRouting>>;
  readonly budgets: {
    readonly maxQualityRounds: number;
    readonly maxGateRounds: number;
    readonly maxReviewRounds: number;
  };
  readonly results: readonly ReplayResult[];
};

const SHA = /^[0-9a-f]{40}$/;

type Json = Readonly<Record<string, unknown>>;

const asObject = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Json
    : null;

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isText = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0;

function caseErrors(value: unknown, at: string, seen: Set<number>): readonly string[] {
  const c = asObject(value);
  if (c === null) return [`${at} is not an object`];
  const errors: string[] = [];
  const { issue } = c;
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
    errors.push(`${at}.issue is not a positive integer`);
  } else if (seen.has(issue)) {
    errors.push(`${at}.issue #${issue} is listed twice`);
  } else {
    seen.add(issue);
  }
  if (!isText(c.title)) errors.push(`${at}.title is not a non-empty string`);
  if (typeof c.seedSha !== "string" || !SHA.test(c.seedSha)) {
    errors.push(`${at}.seedSha is not a 40-hex sha`);
  }
  if (!["recorded", "merge-base", "manual"].includes(c.seedFrom as string)) {
    errors.push(`${at}.seedFrom is not recorded, merge-base or manual`);
  }
  errors.push(...issueJsonErrors(c.issueJson).map((error) => `${at}.issueJson ${error}`));
  if (c.issueFrom === "recorded") {
    if (c.editedAfterAdmission !== undefined) {
      errors.push(`${at}.editedAfterAdmission is set on a recorded issue`);
    }
  } else if (c.issueFrom === "reconstructed") {
    if (typeof c.editedAfterAdmission !== "boolean") {
      errors.push(`${at}.editedAfterAdmission is not a boolean`);
    }
  } else {
    errors.push(`${at}.issueFrom is not recorded or reconstructed`);
  }
  if (c.original !== null) {
    const original = asObject(c.original);
    if (original === null || !isText(original.logsDir) || !isText(original.run)) {
      errors.push(`${at}.original is neither null nor { logsDir, run }`);
    }
  }
  if (c.landed !== null) {
    const landed = asObject(c.landed);
    const diff = asObject(landed?.diff);
    if (
      landed === null ||
      typeof landed.merge !== "string" || !SHA.test(landed.merge) ||
      typeof landed.tip !== "string" || !SHA.test(landed.tip) ||
      diff === null || !isCount(diff.files) || !isCount(diff.insertions) || !isCount(diff.deletions)
    ) {
      errors.push(`${at}.landed is neither null nor { merge, tip, diff } with 40-hex shas and counts`);
    }
  }
  return errors;
}

// The case file, or every way it is not one.
export function parseReplayCases(
  value: unknown,
): { readonly cases: ReplayCases } | { readonly errors: readonly string[] } {
  const root = asObject(value);
  if (root === null) return { errors: ["the case file is not a JSON object"] };
  const errors: string[] = [];
  if (root.replayCases !== 1) errors.push("replayCases is not 1");
  if (typeof root.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(root.repo)) {
    errors.push("repo is not owner/name");
  }
  if (!isText(root.sourceBranch)) errors.push("sourceBranch is not a non-empty string");
  if (!Array.isArray(root.cases) || root.cases.length === 0) {
    errors.push("cases is not a non-empty array");
  } else {
    const seen = new Set<number>();
    root.cases.forEach((c: unknown, i) => errors.push(...caseErrors(c, `cases[${i}]`, seen)));
  }
  return errors.length > 0 ? { errors } : { cases: value as ReplayCases };
}

export type PlannedRun = { readonly repeat: number; readonly case: ReplayCase };

// Every (repeat, case) pair, repeat-major and 1-based.
export function planReplay(
  cases: readonly ReplayCase[],
  repeats: number,
): readonly (readonly PlannedRun[])[] {
  return Array.from({ length: repeats }, (_, i) => cases.map((c) => ({ repeat: i + 1, case: c })));
}

// What would let a replay write to the forge (#195 decision 2). Removed from
// the replay process's environment and from every sandbox's.
export const FORGE_CREDENTIAL_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "SSH_AUTH_SOCK",
] as const;

export function stripForgeCredentials(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const forge: ReadonlySet<string> = new Set(FORGE_CREDENTIAL_KEYS);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !forge.has(key)));
}

// The `git update-ref --stdin` lines that leave a case cache holding exactly
// one ref, `origin/<sourceBranch>` at the seed (#195 decision 3).
export function caseCacheRefUpdates(
  existingRefs: readonly string[],
  sourceBranch: string,
  seedSha: string,
): readonly string[] {
  const seed = `refs/remotes/origin/${sourceBranch}`;
  return [
    ...existingRefs.filter((ref) => ref !== seed).map((ref) => `delete ${ref}`),
    `update ${seed} ${seedSha}`,
  ];
}

// The issue with only the comments made by `cutoff`. A comment whose time is
// unknown cannot be placed before it and is dropped.
export function commentsAtCutoff(issue: IssueJson, cutoff: string): IssueJson {
  const limit = Date.parse(cutoff);
  const madeBy = (comment: IssueComment): boolean =>
    comment.createdAt !== undefined && Date.parse(comment.createdAt) <= limit;
  return { ...issue, comments: (issue.comments ?? []).filter(madeBy) };
}

export type RecordedAdmission = {
  readonly run: string;
  // When it was admitted: the reconstruction's comment cutoff.
  readonly ts: string;
  readonly title: string;
  readonly seedSha: string | null;
  readonly issueSnapshot: string | null;
};

// The admission behind an issue's last DONE in one run's events, or null when
// the run has none. Records are read version-blind (`parseEventLines`), so
// every field is checked rather than trusted.
export function lastDoneAdmission(
  run: string,
  events: readonly Json[],
  issue: number,
): RecordedAdmission | null {
  let admitted: Json | null = null;
  let done: Json | null = null;
  for (const event of events) {
    if (event.issue !== issue) continue;
    if (event.kind === "admitted") admitted = event;
    if (event.kind === "terminal" && event.terminal === "DONE" && admitted !== null) done = admitted;
  }
  if (done === null || typeof done.ts !== "string" || typeof done.title !== "string") return null;
  return {
    run,
    ts: done.ts,
    title: done.title,
    seedSha: typeof done.seedSha === "string" ? done.seedSha : null,
    issueSnapshot: typeof done.issueSnapshot === "string" ? done.issueSnapshot : null,
  };
}

// `git diff --numstat` as a size; a binary file counts as a file of no lines.
export function parseNumstat(numstat: string): DiffSize {
  const rows = numstat.split("\n").filter((line) => line.trim() !== "").map((line) => line.split("\t"));
  const lines = (column: 0 | 1): number =>
    rows.reduce((sum, row) => sum + (Number.parseInt(row[column] ?? "", 10) || 0), 0);
  return { files: rows.length, insertions: lines(0), deletions: lines(1) };
}

// What `replay run` prints before it starts: the size of the spend, who each
// role runs on, and that the quota is shared.
export function renderReplayPlan(args: {
  readonly label: string;
  readonly cases: number;
  readonly repeats: number;
  readonly parallel: number;
  readonly routing: Readonly<Record<string, RoleRouting>>;
}): string {
  const width = Math.max(...Object.keys(args.routing).map((role) => role.length));
  return [
    `replay ${args.label}: ${args.cases} cases × ${args.repeats} = ` +
      `${args.cases * args.repeats} runs, ${args.parallel} at a time`,
    ...Object.entries(args.routing).map(([role, r]) =>
      `  ${role.padEnd(width)}  ${r.agent} ${r.model}${r.effort === null ? "" : ` (effort ${r.effort})`}`),
    "Every run spends real tokens from the same model quota as any sandbar daemon on this account.",
  ].join("\n");
}
