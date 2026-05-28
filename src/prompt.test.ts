import { describe, expect, it } from "vitest";

import { renderReviewerSlot } from "./prompt.js";

const baseInputs = {
  issue: { id: "42", title: "do the thing", branch: "sandcastle/issue-42-do-the-thing" },
  worktreePath: "/tmp/wt",
  sourceBranch: "main",
  codingStandardsPath: "docs/CODING_STANDARDS.md",
  claudeMdPath: "CLAUDE.md",
} as const;

describe("renderReviewerSlot", () => {
  it("references the standards path and conventions", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first\nb2 second",
      diff: "diff --git a/x b/x\n+hi",
    });
    expect(slot).toContain("@docs/CODING_STANDARDS.md");
    expect(slot).toContain("@CLAUDE.md");
  });

  it("includes the optional context-md reference when provided", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      contextMdPath: "CONTEXT.md",
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).toContain("@CONTEXT.md");
  });

  it("omits the context-md reference when not provided", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).not.toContain("CONTEXT.md");
  });

  it("instructs the reviewer not to modify the branch", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).toMatch(/strictly advisory/i);
    expect(slot).toMatch(/must not modify the branch/i);
  });

  it("documents the verdict-token contract with both options", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      diff: "",
    });
    expect(slot).toContain("<verdict>APPROVED</verdict>");
    expect(slot).toContain("<verdict>CHANGES-REQUESTED</verdict>");
    expect(slot).toMatch(/missing verdict defaults to CHANGES-REQUESTED/i);
  });

  it("never carries prior-round transcript fields (statelessness)", () => {
    // The prompt's only inputs are the issue, branch state, and standards
    // pointer — no prior-round prose, no historical verdicts, no "previous
    // round said". Test the negative by checking the rendered output never
    // mentions these patterns even when the diff itself does.
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      diff: "diff --git a/x b/x\n+hi",
    });
    expect(slot).not.toMatch(/previous round/i);
    expect(slot).not.toMatch(/prior round/i);
    expect(slot).not.toMatch(/round 1/i);
    expect(slot).not.toMatch(/last reviewer/i);
  });

  it("renders the commits block when commits exist", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first\nb2 second",
      diff: "diff",
    });
    expect(slot).toContain("## Commits on this branch");
    expect(slot).toContain("a1 first");
    expect(slot).toContain("b2 second");
  });

  it("omits the commits block when commits is empty", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      diff: "diff",
    });
    expect(slot).not.toContain("## Commits on this branch");
  });

  it("renders a small diff inside the diff block", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1",
      diff: "diff --git a/foo b/foo\n+hi\n",
    });
    expect(slot).toContain("## Branch diff");
    expect(slot).toContain("```diff");
    expect(slot).toContain("+hi");
  });

  it("renders a large diff verbatim (no truncation in the renderer)", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `+ line ${i}`).join("\n");
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1",
      diff: `diff --git a/big b/big\n${big}`,
    });
    expect(slot).toContain("+ line 0");
    expect(slot).toContain("+ line 4999");
  });

  it("with no diff, shows the empty-diff placeholder", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      diff: "",
    });
    expect(slot).toContain("(empty — no changes against the source branch)");
  });

  it("includes the issue id and branch in the header", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      diff: "",
    });
    expect(slot).toContain("Issue #42: do the thing");
    expect(slot).toContain("`sandcastle/issue-42-do-the-thing`");
    expect(slot).toContain("`main`");
  });
});
