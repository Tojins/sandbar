import { describe, expect, it } from "vitest";

import { SILENT_NOOP_RETRY_LIMIT } from "./exit-conditions.js";
import {
  type IssueOutcome,
  finalizeKindForSkip,
  mergeFinalizeInputs,
  terminalFinalizeInputs,
} from "./finalize-inputs.js";
import type { IssueRef, MergerSummary } from "./merger.js";

const issue = (id: string): IssueRef => ({
  id,
  title: `issue ${id}`,
  branch: `sandbar/issue-${id}-x`,
});

const summary = (over: Partial<MergerSummary> = {}): MergerSummary => ({
  merged: [],
  skipped: [],
  pushed: false,
  unclosed: [],
  ...over,
});

describe("terminalFinalizeInputs", () => {
  it("produces nothing for DONE — the merger owns that branch", () => {
    const outcomes: IssueOutcome[] = [
      { issue: issue("1"), terminal: { type: "DONE", commits: [{ sha: "a" }] } },
    ];
    expect(terminalFinalizeInputs(outcomes)).toEqual([]);
  });

  it("maps every non-DONE terminal to its handoff kind", () => {
    const outcomes: IssueOutcome[] = [
      { issue: issue("1"), terminal: { type: "NEEDS-INFO", questions: "q?" } },
      {
        issue: issue("2"),
        terminal: { type: "NEEDS-UI-PROTOTYPE", uiImpact: "ui", commits: [] },
      },
      {
        issue: issue("3"),
        terminal: {
          type: "NEEDS-HUMAN",
          cause: "gate-red",
          failureTrace: "boom",
          latestReviewerProse: null,
        },
      },
      {
        issue: issue("4"),
        terminal: {
          type: "NEEDS-HUMAN-REVIEW",
          latestReviewerProse: "nope",
          commits: [],
        },
      },
      {
        issue: issue("5"),
        terminal: { type: "HARD-ERROR", reason: "podman", commits: [] },
      },
    ];
    expect(terminalFinalizeInputs(outcomes).map((i) => i.kind)).toEqual([
      "needs-info",
      "needs-ui-prototype",
      "needs-human",
      "review-budget-exhausted",
      "hard-error",
    ]);
  });

  it("carries the terminal's payload onto the input", () => {
    const [input] = terminalFinalizeInputs([
      {
        issue: issue("3"),
        terminal: {
          type: "NEEDS-HUMAN",
          cause: "uncommittable-worktree",
          failureTrace: "src/a.ts",
          latestReviewerProse: "prose",
        },
      },
    ]);
    expect(input).toEqual({
      kind: "needs-human",
      issue: issue("3"),
      cause: "uncommittable-worktree",
      failureTrace: "src/a.ts",
      latestReviewerProse: "prose",
    });
  });

  // The branch is only worth publishing when there is something on it — see
  // the needs-ui-prototype/hard-error notes in finalize.ts.
  it("derives hasCommits from the terminal's commit list", () => {
    const late = terminalFinalizeInputs([
      {
        issue: issue("2"),
        terminal: {
          type: "NEEDS-UI-PROTOTYPE",
          uiImpact: "ui",
          commits: [{ sha: "a" }],
        },
      },
      {
        issue: issue("5"),
        terminal: { type: "HARD-ERROR", reason: "podman", commits: [] },
      },
    ]);
    expect(late.map((i) => "hasCommits" in i && i.hasCommits)).toEqual([
      true,
      false,
    ]);
  });

  // #30: these inputs are built from Phase 2 alone, so the orchestrator can
  // (and does) finalise them before the merge phase runs at all.
  it("depends on nothing the merger produces", () => {
    const outcomes: IssueOutcome[] = [
      { issue: issue("1"), terminal: { type: "NEEDS-INFO", questions: "q?" } },
      { issue: issue("9"), terminal: { type: "DONE", commits: [] } },
    ];
    expect(terminalFinalizeInputs(outcomes)).toHaveLength(1);
  });
});

describe("finalizeKindForSkip", () => {
  it("maps each skip reason to its handoff", () => {
    expect(finalizeKindForSkip("conflict")).toBe("merge-conflict");
    expect(finalizeKindForSkip("gate-red")).toBe("merge-gate-red");
    expect(finalizeKindForSkip("install-failed")).toBe("merge-gate-red");
    expect(finalizeKindForSkip("forge-unverified")).toBe("forge-unverified");
  });

  it("throws rather than guessing on an unknown reason", () => {
    expect(() =>
      // @ts-expect-error — deliberately outside the union, standing in for a
      // future SkipReason nobody mapped.
      finalizeKindForSkip("teleported"),
    ).toThrow(/Unhandled merger skip reason/);
  });
});

describe("mergeFinalizeInputs", () => {
  it("turns merged issues into merged inputs", () => {
    const { inputs } = mergeFinalizeInputs(
      summary({ merged: [issue("1"), issue("2")] }),
      new Map(),
    );
    expect(inputs).toEqual([
      { kind: "merged", issue: issue("1") },
      { kind: "merged", issue: issue("2") },
    ]);
  });

  it("maps non-silent-noop skips through finalizeKindForSkip", () => {
    const { inputs } = mergeFinalizeInputs(
      summary({
        skipped: [
          { issue: issue("1"), reason: "conflict" },
          { issue: issue("2"), reason: "forge-unverified" },
        ],
      }),
      new Map(),
    );
    expect(inputs.map((i) => i.kind)).toEqual([
      "merge-conflict",
      "forge-unverified",
    ]);
  });

  it("re-enqueues a first silent-noop and bumps its counter", () => {
    const { inputs, bumpedSilentNoop } = mergeFinalizeInputs(
      summary({ skipped: [{ issue: issue("7"), reason: "silent-noop" }] }),
      new Map(),
    );
    expect(inputs).toEqual([{ kind: "fresh-attempt", issue: issue("7") }]);
    expect(bumpedSilentNoop.get("7")).toBe(1);
  });

  it("parks a silent-noop once the retry limit is reached", () => {
    const prior = new Map([["7", SILENT_NOOP_RETRY_LIMIT - 1]]);
    const { inputs, bumpedSilentNoop } = mergeFinalizeInputs(
      summary({ skipped: [{ issue: issue("7"), reason: "silent-noop" }] }),
      prior,
    );
    expect(inputs).toEqual([
      {
        kind: "silent-noop-exhausted",
        issue: issue("7"),
        attempts: SILENT_NOOP_RETRY_LIMIT,
      },
    ]);
    expect(bumpedSilentNoop.get("7")).toBe(SILENT_NOOP_RETRY_LIMIT);
  });

  it("does not mutate the counter map it is given", () => {
    const prior = new Map([["7", 1]]);
    mergeFinalizeInputs(
      summary({ skipped: [{ issue: issue("7"), reason: "silent-noop" }] }),
      prior,
    );
    expect(prior.get("7")).toBe(1);
  });

  it("reports no bumps when nothing silent-nooped", () => {
    const { bumpedSilentNoop } = mergeFinalizeInputs(
      summary({
        merged: [issue("1")],
        skipped: [{ issue: issue("2"), reason: "gate-red" }],
      }),
      new Map(),
    );
    expect(bumpedSilentNoop.size).toBe(0);
  });
});
