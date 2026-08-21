import { describe, expect, it } from "vitest";

import {
  BOT_COMMENT_PREFIX,
  NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE,
  NO_PROTOTYPE_NEEDED_PHRASE,
} from "./finalize.js";
import {
  renderAttemptSlot,
  renderReviewerSlot,
  renderSandboxStackSlot,
} from "./prompt.js";
import { parsePromise } from "./promise-parser.js";

const baseInputs = {
  issue: { id: "42", title: "do the thing", branch: "sandbar/issue-42-do-the-thing" },
  worktreePath: "/tmp/wt",
  sourceBranch: "main",
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
    sourceBranch: "main",
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
    sourceBranch: "main",
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

describe("renderReviewerSlot", () => {
  it("embeds the built-in coding standards and references conventions", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first\nb2 second",
      diff: "diff --git a/x b/x\n+hi",
    });
    expect(slot).toContain("## Coding standards");
    expect(slot).toContain("@CLAUDE.md");
  });

  it("references the optional project standards file when provided", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).toContain("### Project standards");
    expect(slot).toContain("@docs/CODING_STANDARDS.md");
  });

  it("emits only the built-in standards when no project standards file is provided", () => {
    const { codingStandardsPath: _omit, ...noStandards } = baseInputs;
    const slot = renderReviewerSlot({
      ...noStandards,
      commits: "a1 first",
      diff: "diff",
    });
    expect(slot).toContain("## Coding standards");
    expect(slot).not.toContain("### Project standards");
    expect(slot).not.toContain("CODING_STANDARDS");
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
    expect(slot).toContain("`sandbar/issue-42-do-the-thing`");
    expect(slot).toContain("`main`");
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
    address: "127.0.0.1:3306",
    logPath: "/sandbar/logs/db.log",
    up: true,
    failure: null,
  };
  const down = {
    name: "app",
    image: "localhost/app:gate",
    lifecycle: "attempt" as const,
    address: null,
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

  it("names each sibling, its address and the log the agent can read", () => {
    const slot = renderSandboxStackSlot([up]);
    expect(slot).toContain("**db**");
    expect(slot).toContain("127.0.0.1:3306");
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

  // Sandbar knows a port only where a `tcp` readiness wrote one down. Inventing
  // one would send the agent to a socket nothing is listening on and read as
  // the service being broken.
  it("omits the address when no readiness declared a port", () => {
    const slot = renderSandboxStackSlot([{ ...up, address: null }]);
    expect(slot).toContain("**db**");
    expect(slot).not.toContain("127.0.0.1:");
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
      sourceBranch: "main",
      diff: "",
      sandboxStack,
    });

  it("splices the rendered section in", () => {
    expect(slotWith([
      {
        name: "db",
        image: "mariadb",
        lifecycle: "issue",
        address: "127.0.0.1:3306",
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
