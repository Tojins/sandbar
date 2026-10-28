// Reflect's deterministic pass (#182, #207): a window's `StatsReport` reduced
// to what recurs, at zero tokens. Pure; `reflect-cli.ts` reads the report
// through #194 (`readStatsInput` + `computeStats` with prose) and nothing here
// opens a file.
//
// Structured clusters key only on fields the events type (#182 Decision 2):
//   - `gate:<gate>:<step>`, a red gate step (`-` when the record names none);
//   - `park:<TERMINAL>:<cause>`, a non-DONE terminal (`-` with no typed cause);
//   - `fail:<role>:<result>`, an agent invocation that reached no decision;
//   - `overruled:<pass>`, an adjudicator overrule.
// A cluster survives only when it spans two or more distinct issues: a
// one-off is not a lesson. Prose is never keyed; it is bucketed by source for
// the tagger (#208), which labels each finding against the bucket's
// vocabulary in a closed line grammar (`parseTags`), and `tagClusters` then
// keys those labels the same way.
//
// Buckets: `correctness` holds the review invocations of a rejecting round,
// `quality` the quality fixers that committed (until #204 names the rule
// groups, one bucket over sandbar's standards), and `overruled:<pass>` the
// overruling adjudicators. A finding needs its speech, so an invocation whose
// log is gone has none. Scenario failures become a bucket once #180 records
// them. A rule bucket is emitted even when empty: its rules are the universe
// `deletionCandidates` draws from.
//
// Outliers are lessons about issue writing: an issue whose gate, quality and
// review rounds together exceed max(p90 over DONE issues, 2 × median), one
// that declared a spec gap, or one parked NEEDS-INFO or NEEDS-PARTITION.

import { agg, type InvocationRow, type Outcome, type StatsReport } from "./stats.js";

export type Member = {
  readonly run: string;
  readonly issue: number;
  readonly attempt?: number;
  // The invocation's log, under `<logs>/<run>/issue-<N>/`; absent for a gate
  // or a terminal, which have none.
  readonly transcript?: string;
};

export type Cluster = {
  readonly key: string;
  readonly issues: readonly number[];
  readonly count: number;
  readonly members: readonly Member[];
};

export type Rule = { readonly label: string; readonly title: string };

// A rule group's own rules, or an open set the tagger mints `new:<slug>`
// labels into.
export type Vocabulary =
  | {
      readonly kind: "rules";
      readonly rules: readonly Rule[];
      // The distinct issues the group's lister ran on in the window.
      readonly listerIssues: number;
    }
  | { readonly kind: "open" };

export type Finding = {
  readonly id: string;
  readonly run: string;
  readonly issue: number;
  readonly transcript: string;
  readonly prose: string;
};

export type Bucket = {
  readonly source: string;
  readonly vocabulary: Vocabulary;
  readonly findings: readonly Finding[];
};

export type Outlier = {
  readonly issue: number;
  readonly rounds: number;
  readonly attempts: number;
  readonly specGaps: number | null;
  readonly outcome: Outcome;
  readonly reason: string | null;
};

// How the synthesizer cites an outlier issue.
export const outlierKey = (outlier: Pick<Outlier, "issue">): string => `outlier:${outlier.issue}`;

export type Mining = {
  readonly structured: readonly Cluster[];
  readonly buckets: readonly Bucket[];
  readonly outliers: readonly Outlier[];
};

// The text each rule group's lister was given. One group until #204.
export type RuleSets = { readonly quality: string };

// One tagger label on one finding (#208).
export type Tag = { readonly id: string; readonly label: string; readonly gist: string };

// A whole bucket's tags, over all its chunks.
export type TaggedBucket = { readonly bucket: Bucket; readonly tags: readonly Tag[] };

export type DeletionCandidate = {
  readonly key: string;
  readonly title: string;
  readonly listerIssues: number;
};

export const REFLECT_DELETION_MIN_ISSUES = 20;

// The results with which an invocation reached a decision; any other result
// is a `fail:` key.
const DECIDED_RESULTS: ReadonlySet<string> = new Set([
  "completed", "COMPLETE", "NEEDS-INFO", "NEEDS-UI-PROTOTYPE", "CLEAR",
  "PROTOTYPE-NEEDED", "PARTITION", "UPHELD", "OVERRULED", "exit",
]);

const ADJUDICATOR = "adjudicator:";

const OUTLIER_OUTCOMES: ReadonlySet<Outcome> = new Set(["NEEDS-INFO", "NEEDS-PARTITION"]);

type Keyed = { readonly key: string; readonly member: Member };

const memberOf = (row: InvocationRow): Member => ({
  run: row.run,
  issue: row.issue,
  ...(row.attempt === null ? {} : { attempt: row.attempt }),
  ...(row.transcript === null ? {} : { transcript: row.transcript }),
});

// The keys spanning two or more issues, widest first.
function clusters(keyed: readonly Keyed[]): Cluster[] {
  const byKey = new Map<string, Member[]>();
  for (const { key, member } of keyed) byKey.set(key, [...(byKey.get(key) ?? []), member]);
  return [...byKey]
    .map(([key, members]) => ({
      key,
      issues: [...new Set(members.map((member) => member.issue))].sort((a, b) => a - b),
      count: members.length,
      members,
    }))
    .filter((cluster) => cluster.issues.length >= 2)
    .sort((a, b) =>
      b.issues.length - a.issues.length || b.count - a.count || (a.key < b.key ? -1 : 1));
}

function structuredClusters(report: StatsReport): Cluster[] {
  return clusters([
    ...report.gates.filter((gate) => !gate.ok).flatMap((gate) =>
      (gate.redSteps.length === 0 ? ["-"] : gate.redSteps).map((step) => ({
        key: `gate:${gate.gate}:${step}`,
        member: {
          run: gate.run,
          issue: gate.issue,
          ...(gate.attempt === null ? {} : { attempt: gate.attempt }),
        },
      }))),
    ...report.terminals.filter((terminal) => terminal.terminal !== "DONE").map((terminal) => ({
      key: `park:${terminal.terminal}:${terminal.cause ?? "-"}`,
      member: { run: terminal.run, issue: terminal.issue },
    })),
    ...report.invocations.filter((row) => !DECIDED_RESULTS.has(row.result)).map((row) => ({
      key: `fail:${row.role}:${row.result}`,
      member: memberOf(row),
    })),
    ...report.invocations.filter(isOverrule).map((row) => ({
      key: `overruled:${row.role.slice(ADJUDICATOR.length)}`,
      member: memberOf(row),
    })),
  ]);
}

const isOverrule = (row: InvocationRow): boolean =>
  row.role.startsWith(ADJUDICATOR) && row.result === "OVERRULED";

// Numbered `F1`… in record order, which is chronological.
const findingsOf = (rows: readonly InvocationRow[]): Finding[] =>
  rows.flatMap((row) =>
    row.transcript === null || typeof row.prose !== "string"
      ? []
      : [{ run: row.run, issue: row.issue, transcript: row.transcript, prose: row.prose }])
    .map((finding, index) => ({ id: `F${index + 1}`, ...finding }));

function buckets(report: StatsReport, rules: RuleSets): Bucket[] {
  const rows = report.invocations;
  const extracted = extractRules(rules.quality);
  const quality: Bucket = {
    source: "quality",
    vocabulary: {
      kind: "rules",
      rules: extracted.length === 0 ? [{ label: "quality", title: "quality" }] : extracted,
      listerIssues: new Set(rows
        .filter((row) => row.role === "quality-list" || row.role === "quality-fix")
        .map((row) => row.issue)).size,
    },
    findings: findingsOf(rows.filter((row) => row.role === "quality-fix" && (row.commits ?? 0) > 0)),
  };
  const overrules = rows.filter(isOverrule);
  const open: Bucket[] = [
    {
      source: "correctness",
      vocabulary: { kind: "open" },
      findings: findingsOf(rows.filter((row) =>
        row.role === "review" && row.verdict === "CHANGES-REQUESTED")),
    },
    ...[...new Set(overrules.map((row) => row.role))].map((role) => ({
      source: `overruled:${role.slice(ADJUDICATOR.length)}`,
      vocabulary: { kind: "open" } as const,
      findings: findingsOf(overrules.filter((row) => row.role === role)),
    })),
  ];
  return [quality, ...open.filter((bucket) => bucket.findings.length > 0)];
}

function outliers(report: StatsReport): Outlier[] {
  const rounds = (issue: StatsReport["issues"][number]): number =>
    issue.rounds.gate + issue.rounds.quality + issue.rounds.review;
  const done = agg(report.issues.filter((issue) => issue.outcome === "DONE").map(rounds));
  const bar = done.p90 === null || done.median === null ? null : Math.max(done.p90, 2 * done.median);
  return report.issues
    .filter((issue) =>
      (bar !== null && rounds(issue) > bar) ||
      (issue.specGaps ?? 0) > 0 ||
      OUTLIER_OUTCOMES.has(issue.outcome))
    .map((issue) => ({
      issue: issue.issue,
      rounds: rounds(issue),
      attempts: issue.attempts,
      specGaps: issue.specGaps,
      outcome: issue.outcome,
      reason: issue.reason ?? null,
    }));
}

export function mine(report: StatsReport, rules: RuleSets): Mining {
  return {
    structured: structuredClusters(report),
    buckets: buckets(report, rules),
    outliers: outliers(report),
  };
}

// A bucket split, in order, into chunks of at most `maxChars` of prose. A
// finding longer than that is a chunk of its own.
export function chunkBucket(bucket: Bucket, maxChars = 200_000): Bucket[] {
  const chunks: Finding[][] = [];
  let size = 0;
  for (const finding of bucket.findings) {
    const current = chunks.at(-1);
    if (current === undefined || size + finding.prose.length > maxChars) {
      chunks.push([finding]);
      size = finding.prose.length;
    } else {
      current.push(finding);
      size += finding.prose.length;
    }
  }
  return chunks.map((findings) => ({ ...bucket, findings }));
}

// A rule group's vocabulary (#182 Decision 4): `R<n>` for each list item that
// leads with bold, `N. **Title.**` or `- **Title.**`, in order.
export function extractRules(groupText: string): Rule[] {
  return groupText.split("\n")
    .flatMap((line) => {
      const title = /^\s*(?:\d+\.|-)\s+\*\*(.+?)\*\*/.exec(line)?.[1];
      return title === undefined ? [] : [title];
    })
    .map((title, index) => ({ label: `R${index + 1}`, title }));
}

export const TAGS_END = "<tags-end/>";
export const MAX_GIST_CHARS = 160;

const NEW_LABEL = /^new:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_LINE = /^(F\d+) (\S+) ::(.*)$/;

// A tagger's answer over one chunk (#182 Decision 4): a line
// `F<n> <label> :: <gist>` per tag, then the literal `<tags-end/>` as the
// answer's last line. Any other line is the model's own prose and is skipped,
// but a line that leads with a finding id must be a whole tag. A finding may
// carry several labels, each once. An id outside the chunk, a label outside
// its vocabulary (the rules, or a `new:<kebab-slug>` for an open bucket), an
// empty or over-long gist, or a missing end token rejects the whole answer:
// a tag that is half right is not a key.
export function parseTags(
  text: string,
  bucket: Bucket,
): { readonly tags: readonly Tag[] } | { readonly error: string } {
  const lines = text.trimEnd().split("\n");
  if (lines.at(-1)?.trim() !== TAGS_END) return { error: `the answer does not end with ${TAGS_END}` };
  const ids = new Set(bucket.findings.map((finding) => finding.id));
  const { vocabulary } = bucket;
  const inVocabulary = (label: string): boolean => vocabulary.kind === "open"
    ? NEW_LABEL.test(label)
    : vocabulary.rules.some((rule) => rule.label === label);
  const tags: Tag[] = [];
  for (const line of lines.slice(0, -1).map((raw) => raw.trim())) {
    if (!/^F\d+\b/.test(line)) continue;
    const match = TAG_LINE.exec(line);
    if (match === null) return { error: `not a tag line: ${line}` };
    const [, id = "", label = "", rawGist = ""] = match;
    const gist = rawGist.trim();
    if (!ids.has(id)) return { error: `${id} names no finding of this chunk` };
    if (!inVocabulary(label)) return { error: `${label} is not in the ${bucket.source} vocabulary` };
    if (gist.length === 0 || gist.length > MAX_GIST_CHARS) {
      return { error: `${id} ${label}: the gist must be 1-${MAX_GIST_CHARS} chars` };
    }
    if (tags.some((tag) => tag.id === id && tag.label === label)) {
      return { error: `${id} ${label} is tagged twice` };
    }
    tags.push({ id, label, gist });
  }
  return { tags };
}

// `tag:<source>:<label>` over the tagged findings, two or more issues each.
export function tagClusters(tagged: readonly TaggedBucket[]): Cluster[] {
  return clusters(tagged.flatMap(({ bucket, tags }) => tags.map((tag) => {
    const finding = bucket.findings.find((candidate) => candidate.id === tag.id);
    if (finding === undefined) {
      throw new Error(`tag ${tag.id} names no finding of bucket ${bucket.source}`);
    }
    return {
      key: `tag:${bucket.source}:${tag.label}`,
      member: { run: finding.run, issue: finding.issue, transcript: finding.transcript },
    };
  })));
}

// The rules no tag hit (#182 Decision 6), in groups whose lister ran on at
// least REFLECT_DELETION_MIN_ISSUES issues. Only a bucket that was tagged can
// show a rule unused, so an untagged bucket yields none.
export function deletionCandidates(tagged: readonly TaggedBucket[]): DeletionCandidate[] {
  return tagged.flatMap(({ bucket, tags }) => {
    const { vocabulary } = bucket;
    if (vocabulary.kind !== "rules" || vocabulary.listerIssues < REFLECT_DELETION_MIN_ISSUES) {
      return [];
    }
    const hit = new Set(tags.map((tag) => tag.label));
    return vocabulary.rules
      .filter((rule) => !hit.has(rule.label))
      .map((rule) => ({
        key: `rule:${bucket.source}:${rule.label}`,
        title: rule.title,
        listerIssues: vocabulary.listerIssues,
      }));
  });
}
