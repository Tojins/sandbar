import { describe, expect, it } from "vitest";

import type { PriorReviewRound } from "./prompt.js";
import { combineVerifier, renderUnits, reviewScope } from "./verifier.js";

describe("combineVerifier — the white-box review alone (#180)", () => {
  it("parks a write with the reviewer's cause", () => {
    expect(combineVerifier({ kind: "reviewer-wrote", detail: "committed" }))
      .toEqual({ kind: "wrote", cause: "reviewer-wrote", detail: "committed" });
  });

  it("keeps a review that produced nothing a harness failure", () => {
    expect(combineVerifier({ kind: "reviewer-harness-failed", detail: "idle" }))
      .toEqual({ kind: "harness-failed", detail: "idle" });
  });

  it("approves an APPROVED review", () => {
    expect(combineVerifier({ kind: "reviewer-result", verdict: "APPROVED", prose: "ok" }))
      .toEqual({ kind: "approved" });
  });

  it("rejects with one tagged white-box unit, without the verdict token", () => {
    const outcome = combineVerifier({
      kind: "reviewer-result",
      verdict: "CHANGES-REQUESTED",
      prose: "### Correctness\nnull crashes\n\n<verdict>CHANGES-REQUESTED</verdict>\n",
    });
    const text = "[white-box]\n### Correctness\nnull crashes";
    expect(outcome).toEqual({
      kind: "rejected",
      units: [{ id: "white-box", text, publicText: text }],
    });
  });
});

describe("renderUnits", () => {
  const units = [
    { id: "white-box", text: "a", publicText: "A" },
    { id: "white-box", text: "b", publicText: "B" },
  ] as const;

  it("joins the chosen rendering in order, a blank line apart", () => {
    expect(renderUnits(units, "text")).toBe("a\n\nb");
    expect(renderUnits(units, "publicText")).toBe("A\n\nB");
  });
});

describe("reviewScope", () => {
  const round = (n: number, head: string): PriorReviewRound => ({
    round: n,
    head,
    correctness: { verdict: "CHANGES-REQUESTED", prose: "x", specGap: null },
  });

  it.each([
    ["no history", [], [], { kind: "full" }],
    ["an ancestor", [round(1, "a")], ["a"], { kind: "since", sha: "a" }],
    ["a non-ancestor", [round(1, "a")], [], { kind: "full" }],
    [
      "the last of several ancestors",
      [round(1, "a"), round(2, "b"), round(3, "c")],
      ["a", "b"],
      { kind: "since", sha: "b" },
    ],
  ] as const)("anchors at %s", (_name, prior, ancestors, expected) => {
    expect(reviewScope(prior, (sha) => (ancestors as readonly string[]).includes(sha)))
      .toEqual(expected);
  });
});
