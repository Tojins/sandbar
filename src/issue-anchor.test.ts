import { describe, expect, it } from "vitest";

import { renderIssueText, type IssueJson } from "./issue-anchor.js";

describe("renderIssueText", () => {
  it("renders id, title, and body for a comment-less issue", () => {
    const text = renderIssueText("352", {
      title: "Freshness: mental-model curve",
      body: "## Why\n\nThe curve is wrong.\n",
      comments: [],
    });
    expect(text).toContain("Issue #352: Freshness: mental-model curve");
    expect(text).toContain("The curve is wrong.");
    expect(text).not.toContain("## Comments");
  });

  // The regression this module exists for: `gh issue view --comments` piped
  // prints only the comment thread, so a zero-comment issue yielded an empty
  // anchor. The body must always be present in the rendered text.
  it("never renders empty output, even for an empty issue object", () => {
    const text = renderIssueText("7", {});
    expect(text).toContain("Issue #7: (no title)");
    expect(text).toContain("(no description)");
  });

  it("renders the comment thread with author and timestamp", () => {
    const issue: IssueJson = {
      title: "t",
      body: "b",
      comments: [
        {
          author: { login: "alice" },
          createdAt: "2026-06-11T12:46:13Z",
          body: "first comment",
        },
        { body: "anonymous comment" },
      ],
    };
    const text = renderIssueText("9", issue);
    expect(text).toContain("## Comments");
    expect(text).toContain("### alice — 2026-06-11T12:46:13Z");
    expect(text).toContain("first comment");
    expect(text).toContain("### (unknown)");
    expect(text).toContain("anonymous comment");
  });

  it("keeps body before comments (spec first, discussion after)", () => {
    const text = renderIssueText("9", {
      title: "t",
      body: "THE-SPEC",
      comments: [{ body: "THE-COMMENT" }],
    });
    expect(text.indexOf("THE-SPEC")).toBeLessThan(text.indexOf("THE-COMMENT"));
  });
});
