// Reflect's report (#182, #207): the markdown a human reads to decide what to
// file. Pure over the stats header and the mining, so the same window renders
// the same bytes.
//
// Layout: a header (the window, the runs read and skipped, their drivers,
// whether agents ran), then the tables of structured clusters, deletion
// candidates and outliers. The proposals, the no-action and dropped lists and
// the step failures arrive with the tagger and synthesizer (#208), which add
// their sections around these tables; the tables render either way.
//
// The driver renders every citation itself (#182 Decision 5): an issue is
// `owner/repo#N`, and a member's evidence is its log,
// `<logs>/<run>/issue-<N>/<transcript>`, or the issue directory for a gate or
// a terminal, which have no transcript.

import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Cluster, DeletionCandidate, Member, Mining } from "./reflect-mine.js";
import { REFLECT_DELETION_MIN_ISSUES } from "./reflect-mine.js";
import { describeWindow, type StatsReport } from "./stats.js";

export type ReportInput = {
  readonly stats: StatsReport;
  readonly mining: Mining;
  readonly candidates: readonly DeletionCandidate[];
  readonly logsDir: string;
  // `owner/repo`, the prefix of every issue citation.
  readonly repo: string;
};

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

function header(stats: StatsReport): string {
  const list = (items: readonly string[]): string => items.length === 0 ? "none" : items.join(", ");
  return [
    `# Sandbar reflect: ${describeWindow(stats.window)}`,
    "",
    `- Runs read (${stats.runs.length}): ${list(stats.runs.map((run) => code(run.run)))}`,
    `- Runs skipped (${stats.skipped.length}): ${
      list(stats.skipped.map((run) => `${code(run.run)} (${run.reason})`))}`,
    `- Drivers: ${list([...new Set(stats.runs.map((run) => run.driver))])}`,
    `- Agents: not run (${code("--no-agents")})`,
    "",
  ].join("\n");
}

export function renderReport(input: ReportInput): string {
  const { structured, outliers } = input.mining;
  return [
    header(input.stats),
    "## Clusters",
    "",
    "Typed keys seen in two or more issues.",
    "",
    table(["key", "issues", "count"],
      structured.map((cluster) => [code(cluster.key), cluster.issues.length, cluster.count])),
    ...structured.map((cluster) => clusterEvidence(input, cluster)),
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

// `report-<lastRun>-n<runs>-<hash8>.md`: the window's newest run and size,
// and the report's own content, so a re-run over the same window names the
// same file.
export function reportFileName(stats: StatsReport, report: string): string {
  const hash = createHash("sha256").update(report).digest("hex").slice(0, 8);
  return `report-${stats.runs.at(-1)?.run ?? "none"}-n${stats.runs.length}-${hash}.md`;
}
