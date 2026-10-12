import { describe, expect, it } from "vitest";

import {
  NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE,
  NO_PROTOTYPE_NEEDED_PHRASE,
} from "./finalize.js";
import { sourceBranchBase } from "./git-ops.js";
import { reviewerHarnessFailedReprompt } from "./inner-loop-machine.js";
import {
  type PriorReviewRound,
  renderAttemptSlot,
  renderQualitySlot,
  renderReviewerSlot,
  renderSandboxStackSlot,
} from "./prompt.js";
import { parsePromise } from "./promise-parser.js";
import { parseUiCheck } from "./ui-check-parser.js";
import { loadTemplate } from "./prompts.js";

const baseInputs = {
  issue: { id: "42", title: "do the thing", branch: "sandbar/issue-42-do-the-thing" },
  sourceBranch: "main",
  // The default shape since #61: a branch seeded from the source branch, which
  // is every auto-lane issue and every chunk ROOT. `chunkBranch: null` is what
  // makes the chunk-base slots render to nothing.
  base: sourceBranchBase("main"),
  claudeMdPath: "CLAUDE.md",
  priorRounds: [],
} as const;

// The fixer's first pass in a cycle: no earlier head, so no focus stat (#185).
const qualityInputs = {
  ...baseInputs,
  promptExtension: { path: "docs/CODING_STANDARDS.md" },
  lastQualityHead: null,
  changedSinceStat: null,
} as const;

const implementerInputs = {
  issue: baseInputs.issue,
  attempt: 1,
  worktreePath: "/tmp/wt",
  lastFailureTrace: "",
  base: sourceBranchBase("main"),
  claudeMdPath: "CLAUDE.md",
  commits: "",
  stat: "",
  qualityCommitLog: "",
} as const;

describe("renderAttemptSlot — unbounded attempt sequence (#129)", () => {
  it("renders the escalation threshold with its attempt number and no removed maximum", () => {
    const slot = renderAttemptSlot({ ...implementerInputs, attempt: 6 });
    expect(slot).toContain("# Attempt 6");
    expect(slot).toContain("This is attempt 6.");
    expect(slot).not.toMatch(/attempt 6 of \d+/i);
  });
});

describe("renderAttemptSlot — retained reviewer feedback", () => {
  it("renders a correctness rejection as feedback to address", () => {
    const slot = renderAttemptSlot({
      ...implementerInputs,
      latestReviewerFeedback: "Add the missing branch.",
    });
    expect(slot).toContain("Previous reviewer feedback (CHANGES-REQUESTED)");
    expect(slot).toContain("Add the missing branch.");
    expect(slot).toContain("Address the concerns above");
  });

  it("says a harness failure leaves an earlier rejection standing", () => {
    const slot = renderAttemptSlot({
      ...implementerInputs,
      extraReprompt: reviewerHarnessFailedReprompt(true),
      latestReviewerFeedback: "Earlier finding.",
    });
    expect(slot).toContain("Gate-1 passed on the branch's last commit");
    expect(slot).toMatch(/retained CHANGES-REQUESTED report above is from an earlier/);
    expect(slot).toContain("Earlier finding.");
  });

  it("says nobody has reviewed a branch whose first correctness pass failed", () => {
    const note = reviewerHarnessFailedReprompt(false);
    expect(note).toContain("No reviewer has said anything about this branch at all.");
    expect(note).not.toContain("retained");
  });
});

// #185: the implementer is told what the fixer may have done to its branch,
// and what a failing fixer test means, in every prompt and in both follow-ups.
describe("renderAttemptSlot — the quality pass (#185)", () => {
  it("explains the fixer and the rule for its tests on every attempt", () => {
    const slot = renderAttemptSlot(implementerInputs);
    expect(slot).toContain("## The quality pass");
    expect(slot).toMatch(/failing test the quality pass added reports a correctness defect/);
    expect(slot).toMatch(/make that test pass, not to delete it/);
    expect(slot).toMatch(/only when it contradicts the issue[\s\S]*name the test and the reason/);
  });

  it("names the fixer's commits since the last attempt when there are any", () => {
    const slot = renderAttemptSlot({
      ...implementerInputs,
      commits: "aaa impl\nbbb quality: tests",
      stat: " x | 1 +",
      qualityCommitLog: "bbb quality: tests",
    });
    expect(slot).toContain(
      "## Quality pass commits since your last attempt\n\n```\nbbb quality: tests\n```",
    );
    expect(slot.indexOf("## Work done so far")).toBeLessThan(
      slot.indexOf("## Quality pass commits since your last attempt"),
    );
  });

  it("omits the commit section when the fixer committed nothing", () => {
    expect(renderAttemptSlot(implementerInputs)).not.toContain(
      "## Quality pass commits since your last attempt",
    );
  });

  it("repeats the failing-test rule in both follow-ups", () => {
    const gate = renderAttemptSlot({ ...implementerInputs, lastFailureTrace: "FAIL x" });
    expect(gate).toMatch(
      /Previous gate-1 failure[\s\S]*failing test the quality pass\s+added reports a correctness defect/,
    );
    const review = renderAttemptSlot({ ...implementerInputs, latestReviewerFeedback: "finding" });
    expect(review).toMatch(/Previous reviewer feedback[\s\S]*quality pass[\s\S]*not something to delete/);
    for (const followUp of [gate, review]) {
      const section = followUp.slice(followUp.indexOf("## Previous"), followUp.indexOf("## The quality pass"));
      expect(section).toMatch(/only if it contradicts the\s+issue, and then\s+name the test and the reason in that commit's message/);
    }
  });
});

describe("adjudication prompt contracts (#167)", () => {
  it("tells an unchanged implementer attempt how to dispute a false finding", () => {
    const slot = renderAttemptSlot({
      ...implementerInputs,
      latestReviewerFeedback: "false finding",
    });
    expect(slot).toMatch(/If a finding is false at this\s+head, change nothing for it/);
    expect(slot).toContain("independent adjudicator");
  });

  it("requires a fresh whole-report ruling with literal tokens and no implementer advocacy", () => {
    const prompt = loadTemplate("adjudicator");
    expect(prompt).toContain("Read every cited line");
    expect(prompt).toContain("report as a whole");
    expect(prompt).toContain("<ruling>UPHELD</ruling>");
    expect(prompt).toContain("<ruling>OVERRULED</ruling>");
    expect(prompt).not.toContain("implementer");
    expect(prompt).not.toContain("prior round");
  });
});

describe("UI-prototype prompt contracts (#126)", () => {
  const slot = renderAttemptSlot(implementerInputs);
  const uiCheck = loadTemplate("ui-check");

  it("keeps only the mid-implementation escalation in the implementer prompt", () => {
    expect(slot).not.toContain("UI impact check — do this first");
    expect(slot).toContain("If you realise mid-implementation");
    expect(slot).toContain("<promise>NEEDS-UI-PROTOTYPE</promise>");
  });

  // The loop-forever hazard: finalize's comment tells the human to reply with
  // one exact phrase, and this prompt is what has to recognise it in the next
  // run's issue anchor. Reword either side alone and the issue ping-pongs.
  it("recognises the exact escape phrase finalize's comment asks the human for", () => {
    expect(uiCheck).toContain(NO_PROTOTYPE_NEEDED_PHRASE);
    expect(
      NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
        42,
        "impact",
        "needs-info",
        "ready-for-agent",
        null,
        null,
        { kind: "removed" },
      ),
    ).toContain(NO_PROTOTYPE_NEEDED_PHRASE);
  });

  it("documents the dedicated token + block pair its parser accepts", () => {
    expect(uiCheck).toContain("<ui-check>PROTOTYPE-NEEDED</ui-check>");
    expect(uiCheck).toContain("<ui-check>CLEAR</ui-check>");
    expect(uiCheck).toContain("`<ui-impact>`");
    const emitted =
      "<ui-impact>\nnew screen, layout invented\n</ui-impact>\n" +
      "<ui-check>PROTOTYPE-NEEDED</ui-check>";
    expect(parseUiCheck(emitted)).toEqual({
      kind: "PROTOTYPE-NEEDED",
      uiImpact: "new screen, layout invented",
    });
  });

  it("retains an implementer token the promise parser accepts for late discovery", () => {
    const emitted =
      "<ui-impact>late discovery</ui-impact>\n" +
      "<promise>NEEDS-UI-PROTOTYPE</promise>";
    expect(parsePromise(emitted, { commitsAccumulated: 1 })).toEqual({
      kind: "NEEDS-UI-PROTOTYPE",
      uiImpact: "late discovery",
    });
  });
});

// #27. The check that catches an off-branch HEAD costs the agent an attempt and
// then the issue; the prompt is the only chance to prevent it. These pin the
// instruction to the branch the orchestrator actually compares against — a
// prompt that names the wrong ref, or names none, is worse than no prompt.
describe("renderAttemptSlot — commit-on-the-issue-branch rule (#27)", () => {
  const slot = renderAttemptSlot(implementerInputs);

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
  const renderImplementer = (promptExtension?: { readonly path: string } | { readonly text: string }) =>
    renderAttemptSlot({
      ...implementerInputs,
      contextMdPath: "AGENTS.md",
      ...(promptExtension ? { promptExtension } : {}),
    });

  it("carries the quality pass's built-in standards verbatim and host extension", () => {
    const implementer = renderImplementer({ path: "docs/CODING_STANDARDS.md" });
    const quality = renderQualitySlot({
      ...qualityInputs,
      contextMdPath: "AGENTS.md",
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    const codingStandards = loadTemplate("coding-standards");

    expect(implementer).toContain(codingStandards);
    expect(quality).toContain(codingStandards);
    expect(implementer).toMatch(
      /The following is the text the quality pass applies to this branch after you;/,
    );
    expect(implementer).toMatch(/Your work is what these\s+standards are applied to\./);
    expect(implementer).toContain("@docs/CODING_STANDARDS.md");
    expect(implementer).toContain("@CLAUDE.md (and @AGENTS.md if it exists)");
    expect(implementer).toContain("git diff origin/main...HEAD");
    expect(implementer).toContain("git log origin/main..HEAD");
    expect(implementer).not.toContain("module headers, architecture documents, and READMEs");
    expect(implementer).toMatch(/version\s+bumps and changelog entries/);
    expect(implementer).toContain("list its stated requirements");
  });

  it("keeps built-in standards without an optional host extension", () => {
    const slot = renderImplementer();
    expect(slot).toContain("## Coding standards");
    expect(slot).not.toContain("### Project prompt extension");
    expect(slot).not.toContain("CODING_STANDARDS.md");
  });

  it("inlines a text extension verbatim", () => {
    expect(renderImplementer({ text: "host-specific instruction" }))
      .toContain("### Project prompt extension\n\nhost-specific instruction");
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
  it("carries only the correctness reviewer's extension", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      promptExtension: { text: "correctness-only instruction" },
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    expect(slot).toContain(
      "### Project prompt extension\n\ncorrectness-only instruction\n\n## Review process",
    );
    expect(slot.match(/correctness-only instruction/g)).toHaveLength(1);
  });
  // Correctness AND spec, and nothing the quality pass owns (#121): an unmet
  // requirement is the one finding that can invalidate a whole branch, and it
  // is not range-limited, so it belongs in the pass that decides the issue.
  it("covers correctness and spec and excludes standards boilerplate", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first\nb2 second",
      stat: " x | 1 +",
    });
    expect(slot).toMatch(/Correctness of logic/i);
    expect(slot).toMatch(/Spec conformance/i);
    expect(slot).toMatch(/missing\s+requirements and scope creep/);
    expect(slot).toContain("`### Correctness`");
    expect(slot).toContain("`### Spec`");
    expect(slot).toContain("Gate-1 is green");
    expect(slot).toContain("@CLAUDE.md");
    expect(slot).toMatch(/if you cannot name a\s+concrete defect on either dimension, APPROVE/i);
    expect(slot).not.toContain("## Coding standards");
    expect(slot).not.toContain("`### Tests`");
    expect(slot).not.toContain("`### Standards`");
  });

  it("does not reference the optional project standards file", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    expect(slot).not.toContain("### Project standards");
    expect(slot).not.toContain("@docs/CODING_STANDARDS.md");
  });

  it("includes the optional context reference as part of the correctness conventions", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      contextMdPath: "CONTEXT.md",
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    expect(slot).toContain("@CONTEXT.md");
  });

  it("omits the context-md reference when not provided", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    expect(slot).not.toContain("CONTEXT.md");
  });

  it("instructs the reviewer not to modify the branch", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    expect(slot).toMatch(/strictly advisory/i);
    expect(slot).toMatch(/do not run any command that writes under/i);
  });

  it("documents the verdict-token contract with both options", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      stat: "",
    });
    expect(slot).toContain("<verdict>APPROVED</verdict>");
    expect(slot).toContain("<verdict>CHANGES-REQUESTED</verdict>");
    expect(slot).toMatch(/missing verdict is a failed reviewer invocation/i);
  });

  it("omits the prior-round section on the first reviewed round", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first",
      stat: " x | 1 +",
    });
    expect(slot).not.toContain("## Prior review rounds");
  });

  it("renders the commits block when commits exist", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1 first\nb2 second",
      stat: " x.ts | 1 +",
    });
    expect(slot).toContain("## Commits on this branch");
    expect(slot).toContain("a1 first");
    expect(slot).toContain("b2 second");
  });

  it("omits the commits block when commits is empty", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      stat: " x.ts | 1 +",
    });
    expect(slot).not.toContain("## Commits on this branch");
  });

  it("renders a small stat and the on-demand diff command", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1",
      stat: " foo | 1 +\n",
    });
    expect(slot).toContain("## Branch diff stat");
    expect(slot).toContain("foo | 1 +");
    expect(slot).toContain("git diff origin/main...HEAD");
  });

  it("does not turn a large stat into an embedded patch", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `+ line ${i}`).join("\n");
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "a1",
      stat: ` big | ${big.length} +`,
    });
    expect(slot).toContain(`big | ${big.length} +`);
    expect(slot).not.toContain("+ line 0");
  });

  it("with no diff, shows the empty-diff placeholder", () => {
    const slot = renderReviewerSlot({
      ...baseInputs,
      commits: "",
      stat: "",
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
      stat: "",
    });
    expect(slot).toContain("Issue #42: do the thing");
    expect(slot).toContain("`sandbar/issue-42-do-the-thing`");
    expect(slot).toContain("`main`");
  });
});

describe("renderQualitySlot (#185)", () => {
  const renderQuality = () =>
    renderQualitySlot({
      ...qualityInputs,
      contextMdPath: "CONTEXT.md",
      commits: "a1 first",
      stat: " x | 1 +",
    });

  it("is a self-sufficient fixer brief over the whole branch picture", () => {
    const slot = renderQuality();
    expect(slot).toContain("## Commits on this branch");
    expect(slot).toContain("## Branch diff stat");
    expect(slot).toContain("git diff origin/main...HEAD");
    expect(slot).toMatch(/1\. Tests\.[\s\S]*2\. Standards\./);
    expect(slot).toMatch(/by changing the code and committing, never by reporting/);
  });

  // The fixer's output is its commits: nothing in its prompt may ask for a
  // token or a findings report, or a parser would have something to read.
  it("asks for no verdict, no completion token and no findings headings", () => {
    const slot = renderQuality();
    expect(slot).toContain("There is no verdict and no completion token.");
    expect(slot).not.toContain("<verdict>");
    expect(slot).not.toContain("<promise>");
    for (const heading of ["### Tests", "### Standards", "### Correctness", "### Non-blocking"]) {
      expect(slot).not.toContain(`\`${heading}\``);
    }
  });

  it("defines missing and bad tests by what the suite can detect", () => {
    const slot = renderQuality();
    expect(slot).toMatch(/production line the branch changes could\s+be deleted and the suite would stay green/);
    expect(slot).toMatch(/the test itself\s+could be deleted and the suite would stay green/);
  });

  // A failing test is the one channel the fixer has for a correctness defect;
  // it must neither go hunting for them nor quietly change behaviour.
  it("routes correctness through a failing test and nowhere else", () => {
    const slot = renderQuality();
    expect(slot).toMatch(/Do not look for correctness or spec defects, and write no text about them/);
    expect(slot).toMatch(/A test\s+you write that fails IS how a correctness defect is reported/);
    expect(slot).toMatch(/Change production code only to meet a\s+standard/);
  });

  it("asks for one on-branch commit carrying the repository's per-commit rituals", () => {
    const slot = renderQuality();
    expect(slot).toContain("Commit on `sandbar/issue-42-do-the-thing` and stay on it");
    expect(slot).toMatch(/Make ONE commit for this\s+pass/);
    expect(slot).toMatch(/every per-commit ritual the conventions in @CLAUDE\.md \(and @CONTEXT\.md if it exists\)\s+require/);
    expect(slot).toMatch(/anything uncommitted is\s+discarded/);
  });

  it("walks the whole stat on the first pass in a cycle", () => {
    const slot = renderQuality();
    expect(slot).toContain("This is the first quality pass over this branch. Walk every changed file");
    expect(slot).not.toContain("## Changed since your last pass");
  });

  it("focuses a later pass on what changed since the head it last left", () => {
    const slot = renderQualitySlot({
      ...qualityInputs,
      lastQualityHead: "abc1234",
      commits: "a1 first",
      stat: " whole | 1 +",
      changedSinceStat: " x | 1 +",
    });
    expect(slot).toContain("## Changed since your last pass\n\n```\n x | 1 +\n```");
    expect(slot).toContain("git diff abc1234..HEAD");
    expect(slot).toContain("you may still fix anything on the branch");
    expect(slot).toContain("## Branch diff stat\n\n```\n whole | 1 +\n```");
    expect(slot).not.toContain("This is the first quality pass");
  });

  it("renders an empty changed-since stat as no changes since the anchor", () => {
    const slot = renderQualitySlot({
      ...qualityInputs,
      lastQualityHead: "abc1234",
      commits: "a1 first",
      stat: " whole | 1 +",
      changedSinceStat: "",
    });
    expect(slot).toContain("(empty — no changes since `abc1234`)");
  });

  it.each([
    ["a later pass without its stat", "abc1234", null],
    ["a first pass with a stat", null, " x | 1 +"],
  ] as const)("refuses %s rather than claiming no changes", (_name, lastQualityHead, changedSinceStat) => {
    expect(() =>
      renderQualitySlot({
        ...qualityInputs,
        lastQualityHead,
        changedSinceStat,
        commits: "a1 first",
        stat: " whole | 1 +",
      }),
    ).toThrow(/changed-since stat must be supplied exactly when/);
  });

  it("carries the chunk base needed by a cold quality pass", () => {
    const slot = renderQualitySlot({
      ...qualityInputs,
      base: {
        ref: "refs/remotes/origin/sandbar/chunk-1-root",
        chunkBranch: "sandbar/chunk-1-root",
      },
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    expect(slot).toContain("## This branch is part of a chunk");
    expect(slot).toContain("sandbar/chunk-1-root");
    expect(slot).not.toContain("{{");
  });

  it("puts standards and project references in the quality pass", () => {
    const slot = renderQuality();
    expect(slot).toContain("## Coding standards");
    expect(slot).toContain("@docs/CODING_STANDARDS.md");
    expect(slot).toContain("@CLAUDE.md");
    expect(slot).toContain("@CONTEXT.md");
  });

  it("keeps built-in standards when no project standards file is provided", () => {
    const { promptExtension: _omitInput, ...noStandards } = qualityInputs;
    const slot = renderQualitySlot({
      ...noStandards,
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });
    expect(slot).toContain("## Coding standards");
    expect(slot).not.toContain("### Project prompt extension");
    expect(slot).not.toContain("CODING_STANDARDS");
  });
});

describe("reviewer prior-round history (#88)", () => {
  const rejection: PriorReviewRound = {
    round: 1,
    head: "1111111",
    correctness: {
      verdict: "CHANGES-REQUESTED",
      prose: "Null input crashes.\n<verdict>CHANGES-REQUESTED</verdict>",
      specGap: null,
    },
  };
  const approval: PriorReviewRound = {
    round: 2,
    head: "2222222",
    correctness: { verdict: "APPROVED", prose: "<verdict>APPROVED</verdict>", specGap: null },
  };
  const render = (priorRounds: readonly PriorReviewRound[]) =>
    renderReviewerSlot({
      ...baseInputs,
      priorRounds,
      commits: "a1 first",
      stat: " x.ts | 1 +",
    });

  it("renders one prior correctness rejection without its verdict token", () => {
    const slot = render([rejection]);
    expect(slot).toContain(
      "## Prior review rounds\n\nThe following rounds reviewed earlier heads of this branch, in order:\n\n" +
        "### Round 1 — head=1111111\ncorrectness: CHANGES-REQUESTED\nNull input crashes.",
    );
    expect(slot).not.toContain("<verdict>CHANGES-REQUESTED</verdict>\n\n## Review process");
  });

  // The strip recognises exactly what `parseVerdict` does (#113): well-formed
  // tokens go, a malformed tag is prose and stays, and a quoted opener
  // without a closer cannot swallow the findings between it and the real
  // token — which is what #88's round 8 lost.
  it("strips every well-formed verdict token from prior-round prose and nothing else", () => {
    const slot = render([{
      ...rejection,
      correctness: {
        verdict: "CHANGES-REQUESTED",
        prose:
          "Quoted token: <verdict>APPROVED</verdict>.\n" +
          "Malformed token: <verdict>changes requested</verdict>.\n" +
          "Quoted regex: `/<verdict>[\\s\\S]*?<\\/verdict>/g`.\n" +
          "The null branch is unhandled.\n" +
          "<verdict>CHANGES-REQUESTED</verdict>",
        specGap: null,
      },
    }]);
    expect(slot).toContain(
      "correctness: CHANGES-REQUESTED\nQuoted token: .\n" +
        "Malformed token: <verdict>changes requested</verdict>.\n" +
        "Quoted regex: `/<verdict>[\\s\\S]*?<\\/verdict>/g`.\n" +
        "The null branch is unhandled.",
    );
    expect(slot).not.toContain("The null branch is unhandled.\n<verdict>");
  });

  it("renders multiple reviewed rounds in order", () => {
    expect(render([rejection, approval])).toContain(
      "### Round 1 — head=1111111\ncorrectness: CHANGES-REQUESTED\nNull input crashes.\n\n" +
        "### Round 2 — head=2222222\ncorrectness: APPROVED",
    );
  });

  it("gives the reviewer verification and reversal rules", () => {
    const slot = render([]);
    expect(slot).toMatch(/For each finding in the prior-round history/);
    expect(slot).toMatch(/may not be reversed without naming that\s+round/);
    expect(slot).toMatch(/When\s+approving, emit the verdict\s+token alone/);
    expect(slot).toMatch(/review this branch as you would with no history at\s+all/);
    expect(slot).toMatch(/Do not include a summary, what you checked, non-blocking\s+observations/);
  });

  // An implementer that deletes a fixer test must say why; the reviewer is
  // the party told to judge that claim (#185).
  it("tells the reviewer to judge an implementer's change to a quality-pass test", () => {
    expect(render([])).toMatch(/changes or deletes a quality-pass test[\s\S]*judge that claim/);
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

  it("says no runtime is provided only when the gate contributes no attachments", () => {
    expect(renderSandboxStackSlot([up])).toMatch(/not given a container runtime/i);

    const attached = renderSandboxStackSlot([up], true);
    expect(attached).not.toMatch(/not given a container runtime/i);
    expect(attached).toMatch(/mounts and environment.*also attached/is);
    expect(attached).toMatch(/runtime-backed tests/i);
    expect(attached).not.toMatch(/stack is a separate namespace you cannot reach/i);
  });

  // #152: the slot used to offer `gateStack` as "ordinary code you can edit",
  // and an implementer that believes it spends its rounds making the branch fit
  // a stack it cannot move. Both halves are load-bearing — the stack is fixed
  // for this issue, and the gate's `issue` containers keep what an earlier
  // attempt put in them — because together they leave "report it" as the only
  // move, which is the one the outdoor case never took.
  it("says a gateStack change cannot take effect for this issue, and that issue containers persist", () => {
    const slot = renderSandboxStackSlot([up]);
    expect(slot).not.toMatch(/ordinary code you can edit/i);
    expect(slot).toMatch(/not a change you can make take effect here/i);
    expect(slot).toMatch(/outlive your attempts/i);
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
  const slotWith = (
    sandboxStack: Parameters<typeof renderSandboxStackSlot>[0],
    sandboxHasGateAttachments = false,
  ) =>
    renderAttemptSlot({
      ...implementerInputs,
      sandboxStack,
      sandboxHasGateAttachments,
    });

  const sibling = {
    name: "db",
    image: "mariadb",
    lifecycle: "issue" as const,
    logPath: "/sandbar/logs/db.log",
    up: true,
    failure: null,
  };

  it("splices the rendered section in", () => {
    expect(slotWith([sibling])).toContain("## Your sandbox stack");
  });

  it("splices attached gate-access guidance into the assembled attempt", () => {
    const slot = slotWith([sibling], true);
    expect(slot).toMatch(/mounts and environment.*also attached/is);
    expect(slot).toMatch(/runtime-backed tests/i);
    expect(slot).not.toMatch(/not given a container runtime/i);
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
      ...implementerInputs,
      base,
    });

  const reviewerSlot = (base: { ref: string; chunkBranch: string | null }) =>
    renderReviewerSlot({
      ...baseInputs,
      base,
      commits: "a1 first",
      stat: " x | 1 +",
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
    expect(impl).toContain("The summary below");

    const rev = reviewerSlot(chunkBase);
    expect(rev.indexOf("## This branch is part of a chunk")).toBeLessThan(
      rev.indexOf("## Commits on this branch"),
    );
    expect(rev.indexOf("## This branch is part of a chunk")).toBeLessThan(
      rev.indexOf("## Branch diff"),
    );
    expect(rev).toContain("the commits and diff stat below");
    expect(rev).not.toContain("the commits and diff stat above");
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
