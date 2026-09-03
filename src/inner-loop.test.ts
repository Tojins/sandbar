import { describe, expect, it } from "vitest";

import { priorReviewRound, reviewRoundLine } from "./inner-loop.js";
import type { ReviewerOutcome } from "./reviewer-run.js";

const reviewed = (
  verdict: "APPROVED" | "CHANGES-REQUESTED",
  prose: string,
): ReviewerOutcome => ({
  kind: "reviewed",
  verdict: { verdict, prose },
  transcript: prose,
  invocations: 1,
});

const harnessFailed: ReviewerOutcome = {
  kind: "harness-failed",
  detail: "no verdict",
  transcript: "",
  invocations: 2,
};

describe("priorReviewRound (#88)", () => {
  const correctnessApproved = reviewed("APPROVED", "<verdict>APPROVED</verdict>");
  const correctnessRejected = reviewed(
    "CHANGES-REQUESTED",
    "Null input crashes.\n<verdict>CHANGES-REQUESTED</verdict>",
  );
  const followupRejected = reviewed(
    "CHANGES-REQUESTED",
    "### Tests\n\nMissing coverage.\n<verdict>CHANGES-REQUESTED</verdict>",
  );

  it.each([
    {
      name: "correctness harness failure",
      correctness: harnessFailed,
      followup: undefined,
      expected: null,
    },
    {
      name: "correctness rejection",
      correctness: correctnessRejected,
      followup: undefined,
      expected: {
        round: 2,
        head: "abc1234",
        correctness: correctnessRejected.verdict,
      },
    },
    {
      name: "follow-up harness failure",
      correctness: correctnessApproved,
      followup: harnessFailed,
      expected: null,
    },
    {
      name: "reviewed follow-up",
      correctness: correctnessApproved,
      followup: followupRejected,
      expected: {
        round: 2,
        head: "abc1234",
        correctness: correctnessApproved.verdict,
        followup: followupRejected.verdict,
      },
    },
  ])("records $name correctly", ({ correctness, followup, expected }) => {
    expect(priorReviewRound(2, "abc1234", correctness, followup)).toEqual(expected);
  });
});

describe("reviewRoundLine (#88)", () => {
  it.each([
    {
      name: "completed round",
      failed: null,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "correctness=APPROVED followup=CHANGES-REQUESTED durationMs=123",
    },
    {
      name: "harness-failed round",
      failed: { pass: "followup" as const, invocations: 2 },
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "pass=followup harness-failed invocations=2 " +
        "correctness=APPROVED followup=HARNESS-FAILED durationMs=123 " +
        "(round not consumed)",
    },
  ])("formats a $name with its reviewed HEAD", ({ failed, expected }) => {
    expect(
      reviewRoundLine({
        issueId: "88",
        attempt: 5,
        reviewRound: 4,
        head: "abc1234",
        failed,
        correctness: "APPROVED",
        followup: failed ? "HARNESS-FAILED" : "CHANGES-REQUESTED",
        durationField: "durationMs=123",
      }),
    ).toBe(expected);
  });
});
