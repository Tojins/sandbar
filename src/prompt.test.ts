import { describe, expect, it } from "vitest";

import {
  BOT_COMMENT_PREFIX,
  NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE,
  NO_PROTOTYPE_NEEDED_PHRASE,
} from "./finalize.js";
import { sourceBranchBase } from "./git-ops.js";
import {
  renderAttemptSlot,
  renderReviewerFollowupSlot,
  renderReviewerSlot,
  renderSandboxStackSlot,
} from "./prompt.js";
import { parsePromise } from "./promise-parser.js";

const baseInputs = {
  issue: { id: "42", title: "do the thing", branch: "sandbar/issue-42-do-the-thing" },
  worktreePath: "/tmp/wt",
  sourceBranch: "main",
  // The default shape since #61: a branch seeded from the source branch, which
  // is every auto-lane issue and every chunk ROOT. `chunkBranch: null` is what
  // makes the chunk-base slots render to nothing.
  base: sourceBranchBase("main"),
  codingStandardsPath: "docs/CODING_STANDARDS.md",
  claudeMdPath: "CLAUDE.md",
} as const;

// The escalation contract is split across two files — the token/block names
// live as prose in prompts/implementer.md and as regexes in promise-parser.ts.
// These pin them together so a rename on one side can't silently make the
// signal unemittable (#21).
describe("renderAttemptSlot — UI-prototype escalation contract", () => {
  const slot = renderAttemptSlot({
    issue: baseInputs.issue,
    attempt: 1,
    maxAttempts: 8,
    worktreePath: "/tmp/wt",
    lastFailureTrace: "",
    base: sourceBranchBase("main"),
    claudeMdPath: "CLAUDE.md",
    diff: "",
  });

  it("instructs the agent to assess UI impact before implementing", () => {
    expect(slot).toContain("## UI impact check — do this first");
    expect(slot).toContain("non-trivial UI impact");
  });

  // The loop-forever hazard: finalize's comment tells the human to reply with
  // one exact phrase, and this prompt is what has to recognise it in the next
  // run's issue anchor. Reword either side alone and the issue ping-pongs.
  it("recognises the exact escape phrase finalize's comment asks the human for", () => {
    expect(slot).toContain(NO_PROTOTYPE_NEEDED_PHRASE);
    expect(
      NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(42, "impact", "needs-info", "ready-for-agent", null),
    ).toContain(NO_PROTOTYPE_NEEDED_PHRASE);
  });

  // finalize posts under the operator's own account, so its comment is
  // author-indistinguishable from a human reply — and it quotes the escape
  // phrase while asking for it. Without this rule the agent reads the
  // orchestrator's own request back as the human's consent and invents the UI.
  it("tells the agent not to read the bot's own comment as the human's consent", () => {
    expect(slot).toContain(BOT_COMMENT_PREFIX);
    expect(slot).toContain("not a human's answer");
  });

  it("documents a token + block pair the parser actually accepts", () => {
    expect(slot).toContain("<promise>NEEDS-UI-PROTOTYPE</promise>");
    expect(slot).toContain("`<ui-impact>`");
    const emitted =
      "<ui-impact>\nnew screen, layout invented\n</ui-impact>\n" +
      "<promise>NEEDS-UI-PROTOTYPE</promise>";
    expect(parsePromise(emitted, { commitsAccumulated: 0 })).toEqual({
      kind: "NEEDS-UI-PROTOTYPE",
      uiImpact: "new screen, layout invented",
    });
  });
});

// #27. The check that catches an off-branch HEAD costs the agent an attempt and
// then the issue; the prompt is the only chance to prevent it. These pin the
// instruction to the branch the orchestrator actually compares against — a
// prompt that names the wrong ref, or names none, is worse than no prompt.
describe("renderAttemptSlot — commit-on-the-issue-branch rule (#27)", () => {
  const slot = renderAttemptSlot({
    issue: baseInputs.issue,
    attempt: 1,
    maxAttempts: 8,
    worktreePath: "/tmp/wt",
    lastFailureTrace: "",
    base: sourceBranchBase("main"),
    claudeMdPath: "CLAUDE.md",
    diff: "",
  });

  it("names the issue branch as the ref to commit on", () => {
    expect(slot).toContain("Commit on `sandbar/issue-42-do-the-thing`");
  });

  it("says why a detached HEAD is invisible rather than just forbidding it", () => {
    // The agent has to know the worktree will look perfectly clean, or the
    // absence of any complaint reads as confirmation.
    expect(slot).toContain("detach HEAD");
    expect(slot).toContain("clean");
  });

  it("gives the exact command the orchestrator's check is equivalent to", () => {
    expect(slot).toContain("git rev-parse");
    expect(slot).toContain("refs/heads/sandbar/issue-42-do-the-thing");
  });

  it("warns that the correction is a single one", () => {
    expect(slot).toContain(
      "a second attempt still off the branch hands the issue to a human",
    );
  });
});

describe("renderAttemptSlot — implementer standards and pre-promise review (#78)", () => {
  const renderImplementer = (codingStandardsPath?: string) =>
    renderAttemptSlot({
      issue: baseInputs.issue,
      attempt: 1,
      maxAttempts: 8,
      worktreePath: "/tmp/wt",
      lastFailureTrace: "",
      base: sourceBranchBase("main"),
      claudeMdPath: "CLAUDE.md",
      contextMdPath: "AGENTS.md",
      ...(codingStandardsPath ? { codingStandardsPath } : {}),
      diff: "",
    });

  it("carries the reviewer's built-in standards verbatim and host extension", () => {
    const implementer = renderImplementer("docs/CODING_STANDARDS.md");
    const reviewer = renderReviewerFollowupSlot({
      ...baseInputs,
      contextMdPath: "AGENTS.md",
      commits: "a1 first",
      diff: "diff",
    });
    const standardsStart = "Gate-1 is green: every step this project defines";
    const standardsEnd = "No vague disapproval, no\npadding.";

    expect(implementer).toContain(standardsStart);
    expect(implementer).toContain(standardsEnd);
    expect(reviewer).toContain(standardsStart);
    expect(reviewer).toContain(standardsEnd);
    expect(implementer).toContain("@docs/CODING_STANDARDS.md");
    expect(implementer).toContain("@CLAUDE.md (and @AGENTS.md if it exists)");
    expect(implementer).toContain("git diff origin/main...HEAD");
    expect(implementer).toContain("git log origin/main..HEAD");
    expect(implementer).toContain("module headers, architecture documents, and READMEs");
    expect(implementer).toMatch(/version\s+bumps and changelog entries/);
    expect(implementer).toContain("list its stated requirements");
  });

  it("keeps built-in standards without an optional host extension", () => {
    const slot = renderImplementer();
    expect(slot).toContain("## Coding standards");
    expect(slot).not.toContain("### Project standards");
    expect(slot).not.toContain("CODING_STANDARDS.md");
  });

  it("does not bake this host's ritual wording into the shipped prompt", () => {
    const slot = renderImplementer();
    expect(slot).not.toContain("npm version");
    expect(slot).not.toContain("package.json");
  });

  it("places standards and self-review between commit discipline and done signal", () => {
    const slot = renderImplementer();
    expect(slot.indexOf("## Commit discipline")).toBeLessThan(
      slot.indexOf("## Coding standards"),
    );
    expect(slot.indexOf("## Coding standards")).toBeLessThan(
      slot.indexOf("## Pre-promise review"),
    );
    expect(slot.indexOf("## Pre-promise review")).toBeLessThan(
      slot.indexOf("## Done signal"),
    );
  });
});

describe("renderReviewerSlot", () => {
  it("focuses only correctness and excludes standards boilerplate", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first\nb2 second",
      diff: "diff --git a/x b/x\n+hi",
    });
    expect(slot).toMatch(/correctness of logic only/i);
    expect(slot).toContain("Gate-1 is green");
    expect(slot).toContain("@CLAUDE.md");
    expect(slot).toMatch(/if you cannot name a concrete correctness defect,\s*APPROVE/i);
    expect(slot).not.toContain("## Coding standards");
  });

  it("does not reference the optional project standards file", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).not.toContain("### Project standards");
    expect(slot).not.toContain("@docs/CODING_STANDARDS.md");
  });

  it("includes the optional context reference as part of the correctness conventions", () => {
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
    // The placeholder names the SEED REF (#61) — `origin/main` here, the chunk
    // tip for a member — because that is what the emptiness was measured
    // against.
    expect(slot).toContain("(empty — no changes against `origin/main`)");
  });

  it("includes the issue id and branch in the header", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      diff: "",
    });
    expect(slot).toContain("Issue #42: do the thing");
    expect(slot).toContain("`sandbar/issue-42-do-the-thing`");
    expect(slot).toContain("`main`");
  });
});

describe("renderReviewerFollowupSlot", () => {
  const renderFollowup = () =>
    renderReviewerFollowupSlot({
      ...baseInputs,
      contextMdPath: "CONTEXT.md",
      commits: "a1 first",
      diff: "diff --git a/x b/x\n+hi",
    });

  it("is self-sufficient and carries all three ordered dimensions", () => {
    const slot = renderFollowup();
    expect(slot).toContain("## Commits on this branch");
    expect(slot).toContain("## Branch diff");
    expect(slot).toMatch(/1\. Test quality and coverage[\s\S]*2\. Spec conformance[\s\S]*3\. Project standards/);
  });

  it("carries the chunk base needed by a cold follow-up", () => {
    const slot = renderReviewerFollowupSlot({
      ...baseInputs,
      base: {
        ref: "refs/remotes/origin/sandbar/chunk-1-root",
        chunkBranch: "sandbar/chunk-1-root",
      },
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).toContain("## This branch is part of a chunk");
    expect(slot).toContain("sandbar/chunk-1-root");
    expect(slot).not.toContain("{{");
  });

  it("puts standards and project references only in the follow-up", () => {
    const slot = renderFollowup();
    expect(slot).toContain("## Coding standards");
    expect(slot).toContain("@docs/CODING_STANDARDS.md");
    expect(slot).toContain("@CLAUDE.md");
    expect(slot).toContain("@CONTEXT.md");
  });

  it("keeps built-in standards when no project standards file is provided", () => {
    const { codingStandardsPath: _omit, ...noStandards } = baseInputs;
    const slot = renderReviewerFollowupSlot({
      ...noStandards,
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).toContain("## Coding standards");
    expect(slot).not.toContain("### Project standards");
    expect(slot).not.toContain("CODING_STANDARDS");
  });

  it("requires dimension headings and the existing single-verdict contract", () => {
    const slot = renderFollowup();
    expect(slot).toContain("`### Tests`");
    expect(slot).toContain("`### Spec`");
    expect(slot).toContain("`### Standards`");
    expect(slot).toContain("`### Correctness`");
    expect(slot).toMatch(/Do not search for correctness defects/);
    expect(slot).toMatch(/independently notice a concrete correctness defect/);
    expect(slot).toContain("<verdict>APPROVED</verdict>");
    expect(slot).toContain("<verdict>CHANGES-REQUESTED</verdict>");
    expect(slot).toMatch(/Emit exactly one verdict/);
  });
});

// ---------------------------------------------------------------------------
// The sandbox-stack slot (#44 D8)
// ---------------------------------------------------------------------------
//
// Sandbar is the only party that knows which siblings came up THIS attempt,
// which did not, and where their logs are — a consumer's CLAUDE.md would go
// stale the first time it was wrong. So the slot is data, and these pin what
// the data has to say.

describe("renderSandboxStackSlot (#44)", () => {
  const up = {
    name: "db",
    image: "docker.io/library/mariadb:10.11",
    lifecycle: "issue" as const,
    logPath: "/sandbar/logs/db.log",
    up: true,
    failure: null,
  };
  const down = {
    name: "app",
    image: "localhost/app:gate",
    lifecycle: "attempt" as const,
    logPath: "/sandbar/logs/app.log",
    up: false,
    failure:
      "sandbox stack: container 'app' did not become ready within 60000ms\n" +
      "Container log tail:\nPHP Fatal error: syntax error, unexpected ';'",
  };

  // The empty case is the one every existing consumer gets, and it has to cost
  // exactly nothing — an empty heading would be a section about a feature that
  // is not switched on.
  it("renders nothing at all for a stack with no sandbox containers", () => {
    expect(renderSandboxStackSlot([])).toBe("");
  });

  it("names each sibling, its image and the log the agent can read", () => {
    const slot = renderSandboxStackSlot([up]);
    expect(slot).toContain("**db**");
    expect(slot).toContain("/sandbar/logs/db.log");
    expect(slot).toContain("docker.io/library/mariadb:10.11");
  });

  // The whole point of the slot: the agent is told to USE these, because a test
  // it has never watched fail is not evidence.
  it("tells the agent the gate is authoritative and that nothing restarts a sibling", () => {
    const slot = renderSandboxStackSlot([up]);
    expect(slot).toMatch(/gate is authoritative/i);
    expect(slot).toMatch(/restarts a sibling/i);
  });

  // The list is written once, at bringup, and nothing re-reads it — so a
  // sibling that has died since still renders as running. Saying so is the
  // whole of what sandbar does about that, which makes the sentence load-
  // bearing rather than decorative: without it the prompt asserts, every
  // attempt, that a container it has not looked at in an hour is up.
  it("says the list is a bringup snapshot rather than a live readout", () => {
    expect(renderSandboxStackSlot([up])).toMatch(/came up when your sandbox was created/i);
  });

  // D3: an `attempt` sibling that will not start is the branch's own bootstrap
  // breaking, and the agent is the one entity that can fix it. Omitting it
  // would leave the agent to discover a missing service by watching a
  // connection refuse — the guessing this feature exists to end.
  it("lists a container that did not start, with its log tail", () => {
    const slot = renderSandboxStackSlot([up, down]);
    expect(slot).toContain("**app**");
    expect(slot).toMatch(/DID NOT START/);
    expect(slot).toContain("PHP Fatal error");
  });

  // A tail of a healthy service's log in every attempt's prompt is pure noise,
  // and the path is already there for an agent that wants it.
  it("does not paste a log tail for a container that is up", () => {
    expect(renderSandboxStackSlot([up])).not.toContain("```");
  });

  // Since #43 the readiness probe runs inside the container, so no port number
  // is written down anywhere in `gateStack` for sandbar to read. The slot must
  // therefore name none: a port derived from a healthcheck argv is a guess, and
  // an address the agent trusts and cannot reach reads as the service being
  // broken. The loopback fact the template states is not a port.
  it("names no port, because nothing in the config declares one", () => {
    const slot = renderSandboxStackSlot([up, down]);
    expect(slot).toContain("**db**");
    expect(slot).not.toMatch(/127\.0\.0\.1:\d/);
  });
});

// The slot has to reach the assembled prompt, not merely render. It is spliced
// between the branch diff and the round's feedback, so a placeholder rename in
// prompts/implementer.md would otherwise drop it silently — the same class of
// failure as an unemittable escalation token above.
describe("renderAttemptSlot — the sandbox slot reaches the prompt", () => {
  const slotWith = (sandboxStack: Parameters<typeof renderSandboxStackSlot>[0]) =>
    renderAttemptSlot({
      issue: baseInputs.issue,
      attempt: 1,
      maxAttempts: 8,
      worktreePath: "/tmp/wt",
      lastFailureTrace: "",
      base: sourceBranchBase("main"),
      diff: "",
      sandboxStack,
    });

  it("splices the rendered section in", () => {
    expect(slotWith([
      {
        name: "db",
        image: "mariadb",
        lifecycle: "issue",
        logPath: "/sandbar/logs/db.log",
        up: true,
        failure: null,
      },
    ])).toContain("## Your sandbox stack");
  });

  it("leaves no trace of the placeholder when there is no sandbox stack", () => {
    const slot = slotWith([]);
    expect(slot).not.toContain("sandbox stack");
    expect(slot).not.toContain("{{");
  });
});

// #61 — the chunk-base slots. A chunk member's branch is cut from the chunk
// TIP, so the diff and commit list above it are its contribution alone; without
// being told, the implementer goes looking on the source branch for the work it
// is blocked by and re-implements it, and the reviewer reports that same work
// as missing. Both slots are the only place either agent hears the word chunk.
//
// The placeholder-reaches-the-template half matters as much as the prose: a
// rename in prompts/implementer.md drops the whole section silently, which is
// why "no `{{` left" is asserted beside the content.
describe("the chunk-base slots (#61)", () => {
  const chunkBase = {
    ref: "refs/remotes/origin/sandbar/chunk-10-thing",
    chunkBranch: "sandbar/chunk-10-thing",
  } as const;

  const implementerSlot = (base: { ref: string; chunkBranch: string | null }) =>
    renderAttemptSlot({
      issue: baseInputs.issue,
      attempt: 1,
      maxAttempts: 8,
      worktreePath: "/tmp/wt",
      lastFailureTrace: "",
      base,
      diff: "",
    });

  const reviewerSlot = (base: { ref: string; chunkBranch: string | null }) =>
    renderReviewerSlot({
      ...baseInputs,
      base,
      commits: "a1 first",
      diff: "diff --git a/x b/x\n+hi",
    });

  it("tells the implementer its branch was cut from the chunk branch", () => {
    const slot = implementerSlot(chunkBase);

    expect(slot).toContain("## This branch is part of a chunk");
    expect(slot).toContain(chunkBase.chunkBranch);
    // The ref, not just the branch name: a range of the agent's own built on
    // the bare name cannot resolve in a worktree of the bare cache (#40).
    expect(slot).toContain(chunkBase.ref);
    expect(slot).not.toContain("{{");
  });

  // The two failure modes the slot exists to prevent, each named in the prose
  // rather than left to be inferred from "you are in a chunk".
  it("tells the implementer not to go looking for its blockers' work elsewhere", () => {
    const slot = implementerSlot(chunkBase);

    expect(slot).toContain("not re-implement it");
    expect(slot).toContain("out of scope");
  });

  it("tells the reviewer the earlier members' work is not its to review", () => {
    const slot = reviewerSlot(chunkBase);

    expect(slot).toContain("## This branch is part of a chunk");
    expect(slot).toContain(chunkBase.chunkBranch);
    expect(slot).toContain("not report the chunk's existing code as missing");
    expect(slot).not.toContain("{{");
  });

  // The reviewer prose names the ref it should compare against, and it is the
  // seed ref — not `origin/<sourceBranch>`, which for a member is a tree its
  // branch was never cut from.
  it("points the reviewer's own git commands at the seed ref", () => {
    expect(reviewerSlot(chunkBase)).toContain(`against \`${chunkBase.ref}\``);
    expect(reviewerSlot(baseInputs.base)).toContain("against `origin/main`");
  });

  // Where the section SITS, not just what it says. Both templates render it
  // ahead of the changeset, so both must point downwards — and a reviewer sent
  // looking the other way lands on the issue anchor and the header, which is
  // the one place the earlier members work is not. Asserted as an ordering
  // rather than as a word, because the word is only right relative to the
  // template that places it: move the slot and this fails, which is the point.
  it("puts each section above the changeset it points at, and points down", () => {
    const impl = implementerSlot(chunkBase);
    expect(impl.indexOf("## This branch is part of a chunk")).toBeLessThan(
      impl.indexOf("No commits yet on this branch."),
    );
    expect(impl).toContain("The diff below is");

    const rev = reviewerSlot(chunkBase);
    expect(rev.indexOf("## This branch is part of a chunk")).toBeLessThan(
      rev.indexOf("## Commits on this branch"),
    );
    expect(rev.indexOf("## This branch is part of a chunk")).toBeLessThan(
      rev.indexOf("## Branch diff"),
    );
    expect(rev).toContain("the commits and diff below");
    expect(rev).not.toContain("the commits and diff above");
  });

  // Every auto-lane issue and every chunk root. The section must leave no
  // trace: an issue that is NOT in a chunk being told about chunk branches is
  // an invitation to go looking for one.
  it("renders to nothing for a branch seeded from the source branch", () => {
    for (const slot of [implementerSlot(baseInputs.base), reviewerSlot(baseInputs.base)]) {
      expect(slot).not.toContain("part of a chunk");
      expect(slot).not.toContain("chunk");
      expect(slot).not.toContain("{{");
    }
  });
});
