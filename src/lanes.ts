// Lane routing — which of the two landing lanes an issue belongs to (#57, and
// §1 of the design in #54): `auto` (the gate is the last word) or `review`
// (a human reviews before it lands on the source branch).
//
// Two inputs decide it, and nothing else: the `auto-land` LABEL on the issue,
// and `config.defaultLane` for issues that carry no label. There is
// deliberately no `review` label — the host states its default once in config
// and labels only the exceptions. `defaultLane` defaults to "auto", which
// leaves this whole file inert. The label name is hardcoded for the reason
// `ready-for-agent` is: it is protocol, not vocabulary, and a knob would only
// let the two spellings drift.
//
// Review-gating is inherited DOWNWARD, transitively, along blocker →
// dependent `## Blocked by` edges — a descendant of a review-gated issue is
// built on code no human has approved yet — and NEVER the other way.
// `auto-land` on such a descendant is a contradiction and inheritance wins;
// it is not silently ignored: `laneOverrides` names every such issue and
// `postLaneOverrideNotices` says so on the issue itself.
//
// The graph is whatever the caller passes — for the planner, the
// `ready-for-agent` OPEN candidate list, including the `in-chunk` members
// `fetchChunkMembers` lists back in. A blocker OUTSIDE that set contributes
// no gating (there is no lane to read); that is sound because an eligible
// issue's blockers are each CLOSED — landed work, which for a review-gated
// blocker means a human reviewed and landed its chunk, the approval this
// inheritance waits for — or `in-chunk` in the set (plan-resolver.ts's two
// clauses).
//
// Cycles in `## Blocked by` are hostile input; the breadth-first walk visits
// each issue at most once, so a cycle terminates (a cyclic pair is deadlocked
// in the planner regardless).
//
// What a review lane MEANS for the plan (#61) lives in `plan-resolver.ts`;
// this module only computes lanes.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BOT_COMMENT_PREFIX } from "./finalize.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

export type Lane = "review" | "auto";

// The lane an issue takes when it says nothing. "auto" is what sandbar did
// before lanes existed, so every host and this repo change behaviour not at all
// until they ask to.
export const DEFAULT_LANE: Lane = "auto";

export const AUTO_LAND_LABEL = "auto-land";

// The minimum a lane decision needs, rather than plan-resolver's IssueSummary:
// the blocker edges arrive already parsed (`parseBlockedBy`), so this module
// neither knows nor cares that they were written as prose in a `## Blocked by`
// section — and the table tests state a graph instead of building bodies for
// one.
export type LaneIssue = {
  readonly number: number;
  readonly labels: readonly string[];
  readonly blockedBy: readonly number[];
};

export type LaneDecision = {
  // The lane that governs: `declared` unless a review-gated ancestor overrode
  // it.
  readonly lane: Lane;
  // What the issue's own label (or the host default) asked for.
  readonly declared: Lane;
  // The DIRECT blocker whose review-gating propagated here — the near end of
  // the chain, which is the one a human can act on. `null` when the issue's own
  // declaration decided it.
  readonly inheritedFrom: number | null;
};

// An `auto-land` label that inheritance overrode. `gatedBy` is the direct
// blocker that carried the gating in.
export type LaneOverride = {
  readonly issue: number;
  readonly gatedBy: number;
};

export function computeLanes(
  issues: readonly LaneIssue[],
  defaultLane: Lane,
): ReadonlyMap<number, LaneDecision> {
  const decisions = new Map<number, LaneDecision>();
  for (const issue of issues) {
    const declared: Lane = issue.labels.includes(AUTO_LAND_LABEL)
      ? "auto"
      : defaultLane;
    decisions.set(issue.number, { lane: declared, declared, inheritedFrom: null });
  }

  // Blocker → dependents. The edges are reversed HERE rather than walked
  // upward per issue, because that is the direction gating travels and it makes
  // the walk below linear in the graph rather than quadratic in the queue.
  // A self-edge (`#10` inside #10's own `## Blocked by`) is dropped: an issue
  // is not its own ancestor, and keeping it would let a review-gated issue
  // report itself as the source of its own gating.
  const dependents = new Map<number, number[]>();
  for (const issue of issues) {
    for (const blocker of issue.blockedBy) {
      if (blocker === issue.number) continue;
      const existing = dependents.get(blocker);
      if (existing) existing.push(issue.number);
      else dependents.set(blocker, [issue.number]);
    }
  }

  // Breadth-first from every issue that DECLARED review, along blocker →
  // dependent edges. `seen` is what makes a cyclic graph terminate, and it is
  // seeded with the declared-review issues so a cycle among them cannot rewrite
  // one of them as having inherited its own lane.
  const frontier = [...decisions.entries()]
    .filter(([, d]) => d.lane === "review")
    .map(([number]) => number);
  const seen = new Set(frontier);
  for (let i = 0; i < frontier.length; i++) {
    const gate = frontier[i];
    if (gate === undefined) continue;
    for (const dependent of dependents.get(gate) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      const current = decisions.get(dependent);
      // Only issues in the input set have a decision; a dependent always is
      // one, since the edges were built from those issues' own bodies.
      if (!current) continue;
      decisions.set(dependent, {
        lane: "review",
        declared: current.declared,
        inheritedFrom: gate,
      });
      frontier.push(dependent);
    }
  }
  return decisions;
}

// Every issue whose `auto-land` was overridden by inheritance, in issue order.
//
// `declared === "auto"` here can only have come from the label: the other route
// to it is `defaultLane: "auto"`, under which no issue declares review and so
// nothing ever propagates. An override is therefore always a human's label
// being contradicted, which is exactly what is worth saying out loud.
export function laneOverrides(
  decisions: ReadonlyMap<number, LaneDecision>,
): readonly LaneOverride[] {
  const overrides: LaneOverride[] = [];
  for (const [issue, d] of decisions) {
    if (d.lane === "review" && d.declared === "auto" && d.inheritedFrom !== null) {
      overrides.push({ issue, gatedBy: d.inheritedFrom });
    }
  }
  return overrides.sort((a, b) => a.issue - b.issue);
}

// ---------------------------------------------------------------------------
// The override notice
// ---------------------------------------------------------------------------

// What makes the notice idempotent. A review-gated issue is held out of the
// plan and keeps its `ready-for-agent` label, so it is a candidate again every
// cycle of every run — a notice posted unconditionally would be a comment per
// cycle, forever, on an issue nobody is working. An HTML comment because
// GitHub renders it to nothing: the marker is for sandbar, and a human reading
// the thread should see prose.
export const LANE_OVERRIDE_MARKER = "<!-- sandbar:lane-override -->";

export const LANE_OVERRIDE_COMMENT = (gatedBy: number): string =>
  `${BOT_COMMENT_PREFIX} this issue is labelled \`${AUTO_LAND_LABEL}\`, and that ` +
  `label is being overridden. It is blocked by #${gatedBy}, which is review-gated, ` +
  `and review-gating is inherited by everything downstream of it: work here builds ` +
  `on commits no human has approved yet, so it cannot land on the gate's word ` +
  `alone.\n\n` +
  `To make this issue auto-land, put the chain it depends on in the auto lane (or ` +
  `drop the dependency) — relabelling this issue alone will not do it.\n\n` +
  `${LANE_OVERRIDE_MARKER}`;

// Whether this issue has already been told. Matching on the marker rather than
// on the prose means the notice can be reworded without re-notifying every
// overridden issue in every queue.
export function needsLaneOverrideNotice(
  existingComments: readonly string[],
): boolean {
  return !existingComments.some((body) => body.includes(LANE_OVERRIDE_MARKER));
}

async function existingComments(
  repo: RepoRef,
  issueNum: number,
): Promise<readonly string[]> {
  const { stdout } = await exec("gh", [
    "issue",
    "view",
    String(issueNum),
    "--repo",
    repoSlug(repo),
    "--json",
    "comments",
  ]);
  const parsed = JSON.parse(stdout) as {
    comments?: ReadonlyArray<{ body?: string }>;
  };
  return (parsed.comments ?? []).map((c) => c.body ?? "");
}

// Says on the issue that its `auto-land` label lost to inheritance. Returns the
// issues it actually commented on (i.e. the ones not already carrying the
// marker), which is what the caller logs.
//
// Best-effort, and that is the one place this differs from finalize's handoff
// comments, which fail the run loud (#8). Those carry the ONLY copy of
// something — an agent's questions, a failure trace — so a dropped one strands
// a human. This carries a fact that is still true next cycle, on an issue that
// is being held rather than worked, and the marker check means a failed post is
// simply retried on the next plan. Failing the whole run over it would stop
// every other issue for an annotation that self-heals.
export async function postLaneOverrideNotices(
  repo: RepoRef,
  overrides: readonly LaneOverride[],
  log: (line: string) => void | Promise<void> = () => {},
): Promise<readonly number[]> {
  const posted: number[] = [];
  for (const override of overrides) {
    try {
      if (!needsLaneOverrideNotice(await existingComments(repo, override.issue))) {
        continue;
      }
      await exec("gh", [
        "issue",
        "comment",
        String(override.issue),
        "--repo",
        repoSlug(repo),
        "--body",
        LANE_OVERRIDE_COMMENT(override.gatedBy),
      ]);
      posted.push(override.issue);
      await log(
        `lane: #${override.issue} labelled ${AUTO_LAND_LABEL} but review-gated ` +
          `via #${override.gatedBy} — inheritance wins; said so on the issue`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `Could not post the lane-override notice on issue #${override.issue} ` +
          `(retried next cycle): ${detail}`,
      );
      await log(
        `lane: notice for #${override.issue} failed, will retry: ${detail}`,
      );
    }
  }
  return posted;
}
