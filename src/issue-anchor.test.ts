import { describe, expect, it } from "vitest";

import {
  CHUNK_LAND_ABANDONED_PR_COMMENT,
} from "./chunk-land.js";
import {
  NEEDS_HUMAN_COMMENT_TEMPLATE,
  NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE,
  NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE,
  NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE,
  NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE,
  PUSH_REFUSED_COMMENT_TEMPLATE,
  REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE,
} from "./finalize.js";
import {
  dropSandbarTraces,
  renderIssueText,
  type IssueJson,
} from "./issue-anchor.js";
import { buildChunkRefreshFailedComment } from "./merger.js";

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

  it.each([
    {
      name: "an exact prefix",
      body: "**Sandbar:** agent question",
      heading: "### Sandbar (orchestrator, not a human) — 2026-06-11T12:46:13Z",
    },
    {
      name: "a prefix after leading whitespace",
      body: " \n **Sandbar:** agent question",
      heading: "### Sandbar (orchestrator, not a human) — 2026-06-11T12:46:13Z",
    },
    {
      name: "an ordinary human comment",
      body: "human answer",
      heading: "### operator — 2026-06-11T12:46:13Z",
    },
    {
      name: "a quoted sandbar comment",
      body: "> **Sandbar:** agent question\n\nhuman answer",
      heading: "### operator — 2026-06-11T12:46:13Z",
    },
    {
      name: "an inline sandbar mention",
      body: "I am replying to **Sandbar:** with an answer",
      heading: "### operator — 2026-06-11T12:46:13Z",
    },
  ])("attributes $name from the trimmed body's strict prefix", ({ body, heading }) => {
    const text = renderIssueText("9", {
      comments: [
        {
          author: { login: "operator" },
          createdAt: "2026-06-11T12:46:13Z",
          body,
        },
      ],
    });

    expect(text).toContain(heading);
    expect(text).toContain(body.trim());
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

const TRACE = "SENTINEL-TRACE";
const PROSE = "SENTINEL-PROSE";
const BRANCH = "sandbar/issue-9-t";

// Every comment template that carries a trace or quoted reviewer prose, called
// with sentinels in those slots.
const templated: readonly { readonly name: string; readonly body: string }[] = [
  {
    name: "needs-human (gate red, with an earlier report)",
    body: NEEDS_HUMAN_COMMENT_TEMPLATE(BRANCH, "tests", 3, TRACE, PROSE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "needs-human (no signal)",
    body: NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE(BRANCH, 3, TRACE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "needs-human (uncommittable)",
    body: NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE(BRANCH, 2, TRACE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "needs-human (off branch)",
    body: NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE(
      BRANCH,
      2,
      TRACE,
      { branch: BRANCH, headRef: null, headSha: "abc", branchSha: "def" },
      { kind: "removed" },
      "agent-stuck",
      "ready-for-agent",
    ),
  },
  {
    name: "needs-human (reviewer harness, with an earlier report)",
    body: NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE(BRANCH, TRACE, PROSE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "review budget exhausted",
    body: REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(BRANCH, 2, PROSE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "push refused",
    body: PUSH_REFUSED_COMMENT_TEMPLATE({
      branch: BRANCH,
      reasons: [TRACE],
      recovery: { tipSha: "abc", ref: `refs/heads/${BRANCH}`, repoDir: "/cache" },
      stuckLabel: "agent-stuck",
      readyLabel: "ready-for-agent",
    }),
  },
  {
    name: "chunk refresh failed (gate red)",
    body: buildChunkRefreshFailedComment({
      chunkBranch: "sandbar/chunk-9",
      sourceBranch: "main",
      outcome: {
        kind: "abandon",
        mode: "gate-red",
        reason: "r",
        silent: false,
        attempts: [],
        conflictPaths: [],
        gateTrace: TRACE,
        durationMs: 0,
      },
      stuckLabel: "agent-stuck",
    }),
  },
  {
    name: "chunk land abandoned",
    body: CHUNK_LAND_ABANDONED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-9",
      sourceBranch: "main",
      mode: "conflict",
      reason: "r",
      attempts: [],
      conflictPaths: [TRACE],
    }),
  },
];

// Comments posted before the fences existed, one per lead-in line finalize.ts
// has used for quoted reviewer prose.
const legacy = (leadIn: string, tail: string): string =>
  `**Sandbar:** stopped.\n\n${leadIn}\n\n${PROSE}\n\n- more ${PROSE}\n\n${tail}`;
const DETAILS = `<details><summary>Gate trace</summary>\n\n\`\`\`\n${TRACE}\n\`\`\`\n\n</details>`;
const ACTION = "Action: use `b`; push a fix, then drop `agent-stuck` and re-apply `ready-for-agent`.";
const legacyFixtures = [
  "Latest quality review from the red round:",
  "Latest correctness review (an earlier round):",
  "Latest quality reviewer report:",
  "Latest correctness reviewer report:",
  "Latest verifier report:",
  "Latest verifier report (an earlier round):",
  "Earlier-round reviewer report (not a verdict on the current commits):",
  "Read-only quality reviewer output:",
].flatMap((leadIn) => [
  { name: `legacy "${leadIn}" before a trace`, body: legacy(leadIn, `${DETAILS}\n\n${ACTION}`) },
  { name: `legacy "${leadIn}" before the action`, body: legacy(leadIn, ACTION) },
]);

describe("dropSandbarTraces", () => {
  it.each([...templated, ...legacyFixtures])(
    "drops every trace and quote from $name, keeping the stop and action lines",
    ({ body }) => {
      const dropped = dropSandbarTraces(body);
      expect(dropped).not.toContain(TRACE);
      expect(dropped).not.toContain(PROSE);
      expect(dropped.split("\n")[0]).toBe(body.split("\n")[0]);
      const action = body.split("\n").find((l) => l.startsWith("Action:"));
      expect(dropped.split("\n")).toContain(action);
    },
  );

  it("replaces a block and a quote with one stub each", () => {
    const dropped = dropSandbarTraces(
      NEEDS_HUMAN_COMMENT_TEMPLATE(BRANCH, "tests", 3, TRACE, PROSE, "agent-stuck", "ready-for-agent"),
    );
    expect(dropped).toBe(
      "**Sandbar:** stopped after 3 consecutive attempts without a green gate-1; " +
        "latest failing step: `tests`.\n\n" +
        "_(quoted review omitted.)_\n\n" +
        "_(Gate trace omitted.)_\n\n" +
        `Action: use \`${BRANCH}\`; push a fix, then drop \`agent-stuck\` and re-apply \`ready-for-agent\`.`,
    );
  });

  it("cuts a legacy quote that runs to the end of the comment", () => {
    expect(dropSandbarTraces(`**Sandbar:** stopped.\n\nLatest verifier report:\n\n${PROSE}`)).toBe(
      "**Sandbar:** stopped.\n\n_(quoted review omitted.)_",
    );
  });

  it.each([
    { name: "a plain human comment", body: `Latest verifier report:\n\n${PROSE}` },
    { name: "a human comment quoting sandbar mid-text", body: `> **Sandbar:** stopped.\n\n${DETAILS}` },
    { name: "a human comment with its own details", body: `My notes:\n\n${DETAILS}\n\nAction: none` },
  ])("leaves $name byte-identical", ({ body }) => {
    expect(dropSandbarTraces(body)).toBe(body);
  });

  it("leaves a lead-in that does not start a paragraph in place", () => {
    const body = `**Sandbar:** stopped.\nLatest verifier report:\n\n${PROSE}`;
    expect(dropSandbarTraces(body)).toBe(body);
  });
});

describe("renderIssueText — sandbar traces", () => {
  it("drops traces from sandbar comments only, never from the body", () => {
    const text = renderIssueText("9", {
      title: "t",
      body: `Spec.\n\n${DETAILS}`,
      comments: [
        { author: { login: "operator" }, body: `Human.\n\n${DETAILS}` },
        {
          author: { login: "operator" },
          body: NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE(BRANCH, 3, "BOT-TRACE", "agent-stuck", "ready-for-agent"),
        },
      ],
    });
    expect(text.split(TRACE)).toHaveLength(3);
    expect(text).not.toContain("BOT-TRACE");
    expect(text).toContain("_(Attempt summary omitted.)_");
    expect(text).toContain("### Sandbar (orchestrator, not a human)");
  });
});
