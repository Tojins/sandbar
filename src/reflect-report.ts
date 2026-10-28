// Reflect's report (#182, #207, #208): the markdown a human reads to decide
// what to file. Pure over the stats header, the mining and the agents' parsed
// answers, so the same window and the same cached answers render the same
// bytes.
//
// Layout: a header (the window, the runs read and skipped, their drivers, and
// either `--no-agents` or the source tip the agents read and each step's
// cache key and the tokens its answer cost), the proposals grouped by repo
// and category with their evidence, the tables of clusters, deletion
// candidates and outliers, then the no-action, not-addressed and dropped
// lists and the step failures. The tables render even when every step
// failed. Under `--no-agents` only the header and the tables render.
//
// `parseSynthesis` is the synthesizer's grammar (#182 Design): between the
// literal `<proposals>` and `</proposals>`, each `@proposal` carries header
// lines up to its first blank line and then a markdown body, and
// `@no-action <key>: <reason>` accounts for a key that needs none. A
// proposal is dropped, with its reason, for an unknown key, a target outside
// the workspace, a deletion without a `rule:` key, issue writing citing
// fewer than two outliers, or a field its category does not take. Every
// cluster and candidate that no surviving proposal cites and no no-action
// line names is listed as not addressed.
//
// The driver renders every citation itself (#182 Decision 5): an issue is
// `owner/repo#N`, and a member's evidence is its log,
// `<logs>/<run>/issue-<N>/<transcript>`, or the issue directory for a gate or
// a terminal, which have no transcript.

import { createHash } from "node:crypto";
import { join } from "node:path";

import { formatUsageFields, type AgentUsage } from "./agent-usage.js";
import type { Cluster, DeletionCandidate, Member, Outlier } from "./reflect-mine.js";
import { outlierKey, REFLECT_DELETION_MIN_ISSUES } from "./reflect-mine.js";
import { describeWindow, type StatsReport } from "./stats.js";

export const PROPOSAL_CATEGORIES = [
  "prose-edit", "structural-check", "deletion", "issue-writing", "missing-signal",
] as const;
export const PROPOSAL_REPOS = ["sandbar", "consumer"] as const;
export const MECHANISMS = ["lint", "gate-step", "sandbar-code", "script"] as const;
// The target of a proposal about issue writing, which edits no file.
export const ISSUE_WRITING_TARGET = "issue-writing";

type Category = (typeof PROPOSAL_CATEGORIES)[number];
type Mechanism = (typeof MECHANISMS)[number];

export type Proposal = {
  readonly repo: (typeof PROPOSAL_REPOS)[number];
  readonly target: string;
  readonly evidence: readonly string[];
  readonly title: string;
  readonly body: string;
} & (
  | { readonly category: "structural-check"; readonly mechanism: Mechanism }
  | { readonly category: "missing-signal"; readonly event: string }
  | { readonly category: Exclude<Category, "structural-check" | "missing-signal"> }
);

export type NoAction = { readonly key: string; readonly reason: string };
export type Dropped = { readonly title: string; readonly reason: string };

export type Synthesis = {
  readonly proposals: readonly Proposal[];
  readonly noAction: readonly NoAction[];
  readonly dropped: readonly Dropped[];
};

// What a synthesis may cite: every key the synthesizer was shown (clusters,
// candidates and `outlier:<N>`), and every file path in its workspace.
export type SynthesisContext = {
  readonly keys: ReadonlySet<string>;
  readonly targets: ReadonlySet<string>;
};

// One agent step that answered: its cache key and what the answer cost when
// it was produced (absent when the provider measured nothing, #82).
export type StepRecord = {
  readonly step: string;
  readonly key: string;
  readonly usage?: AgentUsage;
};

export type StepFailure = { readonly step: string; readonly reason: string };

export type AgentsRun = {
  readonly sourceBranch: string;
  readonly tip: string;
  readonly steps: readonly StepRecord[];
  readonly failures: readonly StepFailure[];
  // Null when the synthesizer failed or had nothing to read.
  readonly synthesis: Synthesis | null;
};

export type ReportInput = {
  readonly stats: StatsReport;
  // Structured, then tagged.
  readonly clusters: readonly Cluster[];
  readonly candidates: readonly DeletionCandidate[];
  readonly outliers: readonly Outlier[];
  readonly logsDir: string;
  // `owner/repo`, the prefix of every issue citation.
  readonly repo: string;
  // Null under `--no-agents`.
  readonly agents: AgentsRun | null;
};

const FIELDS: ReadonlySet<string> = new Set([
  "category", "repo", "target", "evidence", "mechanism", "event", "title",
]);

const isOneOf = <T extends string>(set: readonly T[], value: string | undefined): value is T =>
  (set as readonly (string | undefined)[]).includes(value);

// One `@proposal` block's lines, after the marker: a proposal, or why not.
function parseProposal(lines: readonly string[], context: SynthesisContext): Proposal | Dropped {
  const blank = lines.findIndex((line) => line.trim() === "");
  const head = blank === -1 ? lines : lines.slice(0, blank);
  const body = (blank === -1 ? [] : lines.slice(blank + 1)).join("\n").trim();
  const fields = new Map<string, string>();
  let malformed: string | null = null;
  for (const line of head) {
    const match = /^([a-z]+):(.*)$/.exec(line.trim());
    const [, name = "", value = ""] = match ?? [];
    if (match === null) malformed ??= `malformed header line: ${line.trim()}`;
    else if (!FIELDS.has(name)) malformed ??= `unknown field ${name}`;
    else if (fields.has(name)) malformed ??= `${name} is given twice`;
    else fields.set(name, value.trim());
  }
  const title = fields.get("title") ?? "";
  const drop = (reason: string): Dropped => ({ title: title === "" ? "(untitled)" : title, reason });
  if (malformed !== null) return drop(malformed);
  if (title === "") return drop("missing title");
  const category = fields.get("category");
  if (!isOneOf(PROPOSAL_CATEGORIES, category)) return drop(`unknown category ${category ?? "(none)"}`);
  const repo = fields.get("repo");
  if (!isOneOf(PROPOSAL_REPOS, repo)) return drop(`repo must be one of ${PROPOSAL_REPOS.join(", ")}`);
  const evidence = (fields.get("evidence") ?? "").split(",").map((key) => key.trim()).filter(Boolean);
  if (evidence.length === 0) return drop("cites no evidence");
  const unknown = evidence.find((key) => !context.keys.has(key));
  if (unknown !== undefined) return drop(`cites unknown key ${unknown}`);
  const target = fields.get("target") ?? "";
  if (target !== ISSUE_WRITING_TARGET && !context.targets.has(target)) {
    return drop(`target ${target === "" ? "(none)" : target} is not a path in the workspace`);
  }
  const mechanism = fields.get("mechanism");
  const event = fields.get("event");
  if ((mechanism !== undefined) !== (category === "structural-check")) {
    return drop("mechanism belongs to a structural-check, and only to one");
  }
  if ((event !== undefined) !== (category === "missing-signal")) {
    return drop("event belongs to a missing-signal, and only to one");
  }
  const base = { repo, target, evidence, title, body };
  switch (category) {
    case "structural-check":
      return isOneOf(MECHANISMS, mechanism)
        ? { ...base, category, mechanism }
        : drop(`mechanism must be one of ${MECHANISMS.join(", ")}`);
    case "missing-signal":
      return event === "" || event === undefined ? drop("missing event") : { ...base, category, event };
    case "deletion":
      return evidence.some((key) => key.startsWith("rule:"))
        ? { ...base, category }
        : drop("a deletion cites no rule: key");
    case "issue-writing":
      return evidence.filter((key) => key.startsWith("outlier:")).length >= 2
        ? { ...base, category }
        : drop("an issue-writing proposal cites fewer than 2 outlier issues");
    case "prose-edit":
      return { ...base, category };
  }
}

// `@no-action <key>: <reason>`, read against the known keys, since a key
// carries colons of its own; the longest one that fits wins.
function parseNoAction(rest: string, keys: ReadonlySet<string>): NoAction | Dropped {
  const key = [...keys]
    .filter((candidate) => rest.startsWith(`${candidate}:`))
    .sort((a, b) => b.length - a.length)[0];
  if (key === undefined) return { title: `@no-action ${rest}`, reason: "names no known key" };
  const reason = rest.slice(key.length + 1).trim();
  return reason === ""
    ? { title: `@no-action ${key}`, reason: "gives no reason" }
    : { key, reason };
}

const PROPOSALS_OPEN = "<proposals>";
const PROPOSALS_CLOSE = "</proposals>";

export function parseSynthesis(
  text: string,
  context: SynthesisContext,
): Synthesis | { readonly error: string } {
  const open = text.lastIndexOf(PROPOSALS_OPEN);
  const close = open === -1 ? -1 : text.indexOf(PROPOSALS_CLOSE, open);
  if (close === -1) return { error: `no ${PROPOSALS_OPEN} … ${PROPOSALS_CLOSE} block` };
  const blocks: { readonly marker: string; readonly lines: string[] }[] = [];
  for (const line of text.slice(open + PROPOSALS_OPEN.length, close).split("\n")) {
    if (/^@(proposal\s*$|no-action )/.test(line)) blocks.push({ marker: line.trim(), lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  const proposals: Proposal[] = [];
  const noAction: NoAction[] = [];
  const dropped: Dropped[] = [];
  for (const { marker, lines } of blocks) {
    if (marker === "@proposal") {
      const parsed = parseProposal(lines, context);
      if ("reason" in parsed) dropped.push(parsed);
      else proposals.push(parsed);
    } else {
      const parsed = parseNoAction(marker.slice("@no-action ".length).trim(), context.keys);
      if ("key" in parsed) noAction.push(parsed);
      else dropped.push(parsed);
    }
  }
  return { proposals, noAction, dropped };
}

type Cell = string | number | null;

// A cell on one line: an absent value renders `-`, and a pipe is escaped.
const cell = (value: Cell): string =>
  value === null ? "-" : String(value).replace(/\s+/g, " ").replace(/\|/g, "\\|");

function table(head: readonly string[], rows: readonly (readonly Cell[])[]): string {
  if (rows.length === 0) return "None.\n";
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

const code = (text: string): string => `\`${text}\``;

const evidence = (input: ReportInput, member: Member): string => {
  const issue = `${input.repo}#${member.issue}`;
  const attempt = member.attempt === undefined ? "" : ` attempt ${member.attempt}`;
  const path = `${join(input.logsDir, member.run, `issue-${member.issue}`)}/${member.transcript ?? ""}`;
  return `- ${issue}${attempt}: ${code(path)}`;
};

const clusterEvidence = (input: ReportInput, cluster: Cluster): string =>
  [`### ${code(cluster.key)}`, "", ...cluster.members.map((member) => evidence(input, member)), ""]
    .join("\n");

const list = (items: readonly string[]): string => items.length === 0 ? "none" : items.join(", ");

function header(input: ReportInput): string {
  const { stats, agents } = input;
  return [
    `# Sandbar reflect: ${describeWindow(stats.window)}`,
    "",
    `- Runs read (${stats.runs.length}): ${list(stats.runs.map((run) => code(run.run)))}`,
    `- Runs skipped (${stats.skipped.length}): ${
      list(stats.skipped.map((run) => `${code(run.run)} (${run.reason})`))}`,
    `- Drivers: ${list([...new Set(stats.runs.map((run) => run.driver))])}`,
    ...agents === null
      ? [`- Agents: not run (${code("--no-agents")})`]
      : [
          `- Agents: over ${code(`origin/${agents.sourceBranch}`)} at ${code(agents.tip)}`,
          `- Steps (${agents.steps.length}):${agents.steps.length === 0 ? " none" : ""}`,
          ...agents.steps.map((step) =>
            `  - ${step.step}: cache ${code(step.key.slice(0, 12))}${
              formatUsageFields(step.usage) || " tokens unmeasured"}`),
        ],
    "",
  ].join("\n");
}

// A key's evidence: a cluster's members, a candidate's rule, an outlier's
// issue. Every key a proposal keeps is one of these, since the parse dropped
// the rest.
function keyEvidence(input: ReportInput, key: string): string[] {
  const cluster = input.clusters.find((candidate) => candidate.key === key);
  if (cluster !== undefined) return cluster.members.map((member) => evidence(input, member));
  const candidate = input.candidates.find((rule) => rule.key === key);
  if (candidate !== undefined) {
    return [`- ${candidate.title} No tag hit over ${candidate.listerIssues} lister issues.`];
  }
  const outlier = input.outliers.find((issue) => outlierKey(issue) === key);
  if (outlier !== undefined) {
    return [`- ${input.repo}#${outlier.issue}: ${outlier.outcome}, ${outlier.rounds} rounds`];
  }
  throw new Error(`proposal evidence ${key} is no cluster, candidate or outlier`);
}

function proposal(input: ReportInput, item: Proposal): string {
  return [
    `### ${item.title}`,
    "",
    `- Target: ${code(item.target)}`,
    ...item.category === "structural-check" ? [`- Mechanism: ${item.mechanism}`] : [],
    ...item.category === "missing-signal" ? [`- Event: ${item.event}`] : [],
    `- Evidence: ${item.evidence.map(code).join(", ")}`,
    "",
    ...item.body === "" ? [] : [item.body, ""],
    ...item.evidence.flatMap((key) => [`#### ${code(key)}`, "", ...keyEvidence(input, key), ""]),
  ].join("\n");
}

function proposals(input: ReportInput, synthesis: Synthesis | null): string {
  const groups = PROPOSAL_REPOS.flatMap((repo) => PROPOSAL_CATEGORIES.map((category) => ({
    heading: `## Proposals: ${repo}, ${category}`,
    items: (synthesis?.proposals ?? [])
      .filter((item) => item.repo === repo && item.category === category),
  }))).filter((group) => group.items.length > 0);
  if (groups.length === 0) return "## Proposals\n\nNone.\n";
  return groups.map((group) =>
    [group.heading, "", ...group.items.map((item) => proposal(input, item))].join("\n")).join("\n");
}

// The clusters and candidates no kept proposal cites and no no-action names.
function notAddressed(input: ReportInput, synthesis: Synthesis | null): string[] {
  const covered = new Set([
    ...(synthesis?.proposals ?? []).flatMap((item) => item.evidence),
    ...(synthesis?.noAction ?? []).map((item) => item.key),
  ]);
  return [...input.clusters, ...input.candidates]
    .map((item) => item.key)
    .filter((key) => !covered.has(key));
}

const bullets = (items: readonly string[]): string =>
  items.length === 0 ? "None.\n" : `${items.map((item) => `- ${item}`).join("\n")}\n`;

function accounting(input: ReportInput, agents: AgentsRun): string {
  const { synthesis } = agents;
  return [
    "## No action",
    "",
    bullets((synthesis?.noAction ?? []).map((item) => `${code(item.key)}: ${item.reason}`)),
    "## Not addressed",
    "",
    bullets(notAddressed(input, synthesis).map(code)),
    "## Dropped by the driver",
    "",
    bullets((synthesis?.dropped ?? []).map((item) => `${item.title}: ${item.reason}`)),
    "## Step failures",
    "",
    bullets(agents.failures.map((failure) => `${failure.step}: ${failure.reason}`)),
  ].join("\n");
}

function tables(input: ReportInput): string {
  const { clusters, outliers } = input;
  return [
    "## Clusters",
    "",
    "Typed keys seen in two or more issues.",
    "",
    table(["key", "issues", "count"],
      clusters.map((cluster) => [code(cluster.key), cluster.issues.length, cluster.count])),
    ...clusters.map((cluster) => clusterEvidence(input, cluster)),
    "## Deletion candidates",
    "",
    `Rules no tag hit, in groups whose lister ran on at least ${REFLECT_DELETION_MIN_ISSUES} issues.`,
    "",
    table(["key", "rule", "lister issues"],
      input.candidates.map((candidate) => [code(candidate.key), candidate.title, candidate.listerIssues])),
    "## Outliers",
    "",
    "Issues whose rounds exceed max(p90, 2 × median) over DONE issues, that declared a spec gap, " +
      "or that parked NEEDS-INFO or NEEDS-PARTITION.",
    "",
    table(["issue", "outcome", "rounds", "attempts", "spec gaps", "reason"],
      outliers.map((outlier) => [
        `${input.repo}#${outlier.issue}`, outlier.outcome, outlier.rounds, outlier.attempts,
        outlier.specGaps, outlier.reason,
      ])),
  ].join("\n");
}

export function renderReport(input: ReportInput): string {
  const { agents } = input;
  return agents === null
    ? [header(input), tables(input)].join("\n")
    : [header(input), proposals(input, agents.synthesis), tables(input), accounting(input, agents)]
      .join("\n");
}

// `report-<lastRun>-n<runs>-<hash8>.md`: the window's newest run and size,
// and the report's own content, so a re-run over the same window names the
// same file.
export function reportFileName(stats: StatsReport, report: string): string {
  const hash = createHash("sha256").update(report).digest("hex").slice(0, 8);
  return `report-${stats.runs.at(-1)?.run ?? "none"}-n${stats.runs.length}-${hash}.md`;
}
