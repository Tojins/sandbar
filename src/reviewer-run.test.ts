import { describe, expect, it } from "vitest";

import {
  REVIEWER_DETAIL_TAIL_CHARS,
  REVIEWER_MAX_INVOCATIONS,
  continueReviewerSession,
  decideReviewRound,
  type ReviewerOutcome,
  type ReviewerRun,
  runReviewerInvocations,
} from "./reviewer-run.js";
import { parseVerdict } from "./verdict-parser.js";

// The observed failure (#41): the reviewer emitted nothing at all for 15
// minutes and the harness's own error text was fed forward as review prose.
const IDLE = "Agent idle for 600 seconds — no output received.";
const idleRun: ReviewerRun = { output: "", error: IDLE };
const blankRun: ReviewerRun = { output: "   \n", error: null };

const reviewed = (stdout: string): ReviewerOutcome => {
  const verdict = parseVerdict(stdout);
  if (verdict === null) throw new Error("reviewed fixture requires a verdict token");
  return { kind: "reviewed", verdict, transcript: stdout, invocations: 1 };
};
const failed = (detail: string): ReviewerOutcome => ({
  kind: "harness-failed",
  detail,
  transcript: "",
  invocations: 2,
});

describe("sequential review round policy", () => {
  it.each([
    ["correctness", 1, false],
    ["correctness", 2, false],
    ["followup", 1, true],
    ["followup", 2, false],
  ] as const)("pass=%s invocation=%i continue=%s", (pass, invocation, expected) => {
    expect(continueReviewerSession(pass, invocation)).toBe(expected);
  });

  it("correctness harness failure finishes without spending a round", () => {
    expect(decideReviewRound(failed("idle"))).toEqual({
      kind: "finished",
      event: { kind: "reviewer-harness-failed", detail: "correctness: idle" },
      correctness: "HARNESS-FAILED",
      followup: "SKIPPED",
    });
  });

  it("correctness changes skip follow-up and receive the dimension heading", () => {
    expect(
      decideReviewRound(reviewed("broken edge\n<verdict>CHANGES-REQUESTED</verdict>")),
    ).toEqual({
      kind: "finished",
      event: {
        kind: "reviewer-result",
        verdict: "CHANGES-REQUESTED",
        prose:
          "### Correctness\n\nbroken edge\n<verdict>CHANGES-REQUESTED</verdict>",
      },
      correctness: "CHANGES-REQUESTED",
      followup: "SKIPPED",
    });
  });

  it("approved correctness requests the follow-up", () => {
    expect(decideReviewRound(reviewed("<verdict>APPROVED</verdict>"))).toEqual({
      kind: "run-followup",
    });
  });

  it("follow-up harness failure discards the approval and retries the action", () => {
    expect(
      decideReviewRound(reviewed("<verdict>APPROVED</verdict>"), failed("crashed")),
    ).toEqual({
      kind: "finished",
      event: { kind: "reviewer-harness-failed", detail: "followup: crashed" },
      correctness: "APPROVED",
      followup: "HARNESS-FAILED",
    });
  });

  it.each(["APPROVED", "CHANGES-REQUESTED"] as const)(
    "APPROVED + %s produces the follow-up verdict and prose",
    (verdict) => {
      expect(
        decideReviewRound(
          reviewed("<verdict>APPROVED</verdict>"),
          reviewed(`checklist prose\n<verdict>${verdict}</verdict>`),
        ),
      ).toEqual({
        kind: "finished",
        event: {
          kind: "reviewer-result",
          verdict,
          prose: `checklist prose\n<verdict>${verdict}</verdict>`,
        },
        correctness: "APPROVED",
        followup: verdict,
      });
    },
  );
});

// Drives the policy over a fixed script, recording what it was asked for.
function drive(script: readonly ReviewerRun[]) {
  const asked: number[] = [];
  const retries: { invocation: number; detail: string }[] = [];
  return runReviewerInvocations(
    async (n) => {
      asked.push(n);
      const run = script[n - 1];
      if (run === undefined) throw new Error(`invoked ${n} times; script has ${script.length}`);
      return { kind: "run", run };
    },
    { onRetry: (invocation, detail) => void retries.push({ invocation, detail }) },
  ).then((outcome) => ({ outcome, asked, retries }));
}

describe("review eligibility", () => {
  it.each([
    ["completed", true, null, "<verdict>APPROVED</verdict>", "reviewed"],
    ["completed", false, null, "looks fine to me", "harness-failed"],
    ["failed", true, "exited 1", "…<verdict>APPROVED</verdict>\n", "reviewed"],
    [
      "failed",
      false,
      IDLE,
      "Let me start by reading the diff.",
      "harness-failed",
    ],
  ] as const)(
    "state=%s token=%s is classified from output",
    async (_state, _hasToken, error, output, expectedKind) => {
      const run = { output, error };
      const { outcome } = await drive([run, run]);
      expect(outcome.kind).toBe(expectedKind);
    },
  );
});

describe("runReviewerInvocations", () => {
  it("a reviewing first invocation is not retried", async () => {
    const { outcome, asked, retries } = await drive([
      { output: "prose\n<verdict>CHANGES-REQUESTED</verdict>", error: null },
    ]);
    expect(asked).toEqual([1]);
    expect(retries).toEqual([]);
    expect(outcome.kind).toBe("reviewed");
    if (outcome.kind !== "reviewed") throw new Error("unreachable");
    expect(outcome.invocations).toBe(1);
    expect(outcome.verdict.verdict).toBe("CHANGES-REQUESTED");
  });

  it("zero output is retried once, and a review on the retry is the outcome", async () => {
    const { outcome, asked, retries } = await drive([
      idleRun,
      { output: "real review\n<verdict>APPROVED</verdict>", error: null },
    ]);
    expect(asked).toEqual([1, 2]);
    expect(retries.map((r) => r.invocation)).toEqual([1]);
    expect(retries[0]?.detail).toContain(IDLE);
    expect(outcome.kind).toBe("reviewed");
    if (outcome.kind !== "reviewed") throw new Error("unreachable");
    expect(outcome.invocations).toBe(2);
    // The verdict is parsed from the REVIEWING invocation alone. Handing the
    // transcript to the parser would put the previous invocation's harness
    // error into the prose an implementer and a human both read as the
    // reviewer's own words.
    expect(outcome.verdict.prose).not.toContain(IDLE);
    expect(outcome.verdict.verdict).toBe("APPROVED");
  });

  it("two zero-output runs are a harness failure, never a verdict", async () => {
    const { outcome, asked, retries } = await drive([idleRun, idleRun]);
    expect(asked).toEqual([1, 2]);
    // No retry callback after the LAST invocation — nothing is being retried.
    expect(retries.map((r) => r.invocation)).toEqual([1]);
    expect(outcome.kind).toBe("harness-failed");
    if (outcome.kind !== "harness-failed") throw new Error("unreachable");
    expect(outcome.invocations).toBe(REVIEWER_MAX_INVOCATIONS);
    expect(outcome.detail).toContain("invocation 1/2");
    expect(outcome.detail).toContain("invocation 2/2");
    expect(outcome.detail).toContain("emitted no output at all");
  });

  it("a run that completed having printed nothing is a harness failure too", async () => {
    const { outcome } = await drive([blankRun, blankRun]);
    expect(outcome.kind).toBe("harness-failed");
    if (outcome.kind !== "harness-failed") throw new Error("unreachable");
    expect(outcome.detail).toContain("the run completed and emitted no output at all");
  });

  it("a completed tokenless review is reported with its output", async () => {
    const prose = "I found a concrete problem but forgot the contract token.";
    const { outcome } = await drive([
      { output: prose, error: null },
      { output: prose, error: null },
    ]);
    expect(outcome.kind).toBe("harness-failed");
    if (outcome.kind !== "harness-failed") throw new Error("unreachable");
    expect(outcome.detail).toContain("completed but emitted no verdict token");
    expect(outcome.detail).toContain(prose);
    expect(outcome.detail).not.toContain("emitted no output at all");
  });

  it("a failure that reached a verdict is taken at its word, with no retry", async () => {
    const { outcome, asked } = await drive([
      { output: "findings\n<verdict>APPROVED</verdict>\n", error: "exited with code 1" },
    ]);
    expect(asked).toEqual([1]);
    expect(outcome.kind).toBe("reviewed");
    if (outcome.kind !== "reviewed") throw new Error("unreachable");
    expect(outcome.verdict.verdict).toBe("APPROVED");
  });

  it("a failure with prose but no verdict is a harness failure that keeps the prose", async () => {
    const partial = "Reading the diff for src/foo.ts…";
    const { outcome } = await drive([
      { output: partial, error: IDLE },
      { output: partial, error: IDLE },
    ]);
    expect(outcome.kind).toBe("harness-failed");
    if (outcome.kind !== "harness-failed") throw new Error("unreachable");
    // The detail is diagnostics for a log and a human handoff, so the half-
    // written review survives there — it is the only artefact of what the
    // reviewer was doing. It is NOT prose attributed to the reviewer; the state
    // machine keeps it out of the implementer's prompt.
    expect(outcome.detail).toContain(partial);
    expect(outcome.detail).toContain("failed before reaching a verdict");
  });

  it("the detail elides a huge partial output; the transcript keeps all of it", async () => {
    const huge = "x".repeat(REVIEWER_DETAIL_TAIL_CHARS * 3);
    const { outcome } = await drive([
      { output: huge, error: IDLE },
      { output: huge, error: IDLE },
    ]);
    if (outcome.kind !== "harness-failed") throw new Error("expected harness-failed");
    expect(outcome.detail).toContain("earlier chars elided");
    expect(outcome.detail.length).toBeLessThan(huge.length);
    expect(outcome.transcript).toContain(huge);
  });

  it("the transcript records every invocation, including the silent ones", async () => {
    const { outcome } = await drive([
      idleRun,
      { output: "second\n<verdict>APPROVED</verdict>", error: null },
    ]);
    expect(outcome.transcript).toContain("=== reviewer invocation 1 ===");
    expect(outcome.transcript).toContain("(no output)");
    expect(outcome.transcript).toContain(`reviewer run errored: ${IDLE}`);
    expect(outcome.transcript).toContain("=== reviewer invocation 2 ===");
    expect(outcome.transcript).toContain("second");
  });

  it("honours a caller-supplied invocation budget", async () => {
    let calls = 0;
    const single = await runReviewerInvocations(
      async () => {
        calls++;
        return { kind: "run", run: idleRun };
      },
      { maxInvocations: 1 },
    );
    expect(calls).toBe(1);
    expect(single.invocations).toBe(1);
    expect(single.kind).toBe("harness-failed");
  });

  it("returns an aborted reviewer write without retrying", async () => {
    const event = { kind: "reviewer-wrote", detail: "changed HEAD" } as const;
    const asked: number[] = [];
    const outcome = await runReviewerInvocations(async (n) => {
      asked.push(n);
      return { kind: "aborted", event, transcript: "partial output" };
    });

    expect(outcome).toEqual({
      kind: "aborted",
      event,
      transcript: "partial output",
    });
    expect(asked).toEqual([1]);
  });
});
