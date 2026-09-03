import { describe, expect, it } from "vitest";
import {
  PROMISE_COMPLETION_SIGNALS,
  parsePromise,
} from "./promise-parser.js";

const withCommits = { commitsAccumulated: 1 } as const;
const noCommits = { commitsAccumulated: 0 } as const;

describe("parsePromise", () => {
  it("exports every parsed token as an implementer completion signal", () => {
    expect(PROMISE_COMPLETION_SIGNALS).toEqual([
      "<promise>COMPLETE</promise>",
      "<promise>NEEDS-INFO</promise>",
      "<promise>NEEDS-UI-PROTOTYPE</promise>",
    ]);
  });

  it("returns COMPLETE when a single COMPLETE token is present and commits exist", () => {
    expect(parsePromise("done\n<promise>COMPLETE</promise>", withCommits)).toEqual({
      kind: "COMPLETE",
    });
  });

  it("returns NEEDS-INFO with the questions when token + block both present", () => {
    const out =
      "I need clarification.\n" +
      "<questions>\n- What is X?\n- Should Y do Z?\n</questions>\n" +
      "<promise>NEEDS-INFO</promise>";
    expect(parsePromise(out, withCommits)).toEqual({
      kind: "NEEDS-INFO",
      questions: "- What is X?\n- Should Y do Z?",
    });
  });

  it("returns NO-SIGNAL with reprompt when NEEDS-INFO has no questions block", () => {
    const r = parsePromise("<promise>NEEDS-INFO</promise>", withCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") expect(r.reprompt).toContain("no `<questions>` block");
  });

  it("returns NO-SIGNAL with reprompt when NEEDS-INFO has empty questions block", () => {
    const r = parsePromise(
      "<questions>\n   \n</questions>\n<promise>NEEDS-INFO</promise>",
      withCommits,
    );
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") expect(r.reprompt).toContain("no `<questions>` block");
  });

  it("returns NO-SIGNAL with reprompt when COMPLETE is emitted with zero commits", () => {
    const r = parsePromise("<promise>COMPLETE</promise>", noCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") expect(r.reprompt).toContain("no commits");
  });

  it("when multiple promise tags appear, the last one wins", () => {
    const out =
      "<promise>NEEDS-INFO</promise>\n" +
      "later I figured it out\n" +
      "<promise>COMPLETE</promise>";
    expect(parsePromise(out, withCommits)).toEqual({ kind: "COMPLETE" });
  });

  it("last-wins also drops a previous COMPLETE when the agent later asks for info", () => {
    const out =
      "<promise>COMPLETE</promise>\n" +
      "<questions>\n- Actually what about edge case Q?\n</questions>\n" +
      "<promise>NEEDS-INFO</promise>";
    expect(parsePromise(out, withCommits)).toEqual({
      kind: "NEEDS-INFO",
      questions: "- Actually what about edge case Q?",
    });
  });

  it("returns NEEDS-UI-PROTOTYPE with the impact block when token + block present", () => {
    const out =
      "This adds a screen nobody has specified.\n" +
      "<ui-impact>\nNew settings page; tab order and empty state invented.\n</ui-impact>\n" +
      "<promise>NEEDS-UI-PROTOTYPE</promise>";
    expect(parsePromise(out, noCommits)).toEqual({
      kind: "NEEDS-UI-PROTOTYPE",
      uiImpact: "New settings page; tab order and empty state invented.",
    });
  });

  it("returns NO-SIGNAL with reprompt when NEEDS-UI-PROTOTYPE has no ui-impact block", () => {
    const r = parsePromise("<promise>NEEDS-UI-PROTOTYPE</promise>", noCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") expect(r.reprompt).toContain("no `<ui-impact>` ");
  });

  it("returns NO-SIGNAL with reprompt when NEEDS-UI-PROTOTYPE has an empty ui-impact block", () => {
    const r = parsePromise(
      "<ui-impact>\n  \n</ui-impact>\n<promise>NEEDS-UI-PROTOTYPE</promise>",
      noCommits,
    );
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") expect(r.reprompt).toContain("no `<ui-impact>` ");
  });

  // A late escalation (the agent only realised mid-implementation) is accepted
  // rather than reprompted — the mirror image of the COMPLETE-no-commits guard
  // would punish the agent for noticing at all (#21).
  it("accepts NEEDS-UI-PROTOTYPE even when commits already exist", () => {
    const out =
      "<ui-impact>\nHalfway in I'm inventing the layout.\n</ui-impact>\n" +
      "<promise>NEEDS-UI-PROTOTYPE</promise>";
    expect(parsePromise(out, withCommits)).toEqual({
      kind: "NEEDS-UI-PROTOTYPE",
      uiImpact: "Halfway in I'm inventing the layout.",
    });
  });

  // Blocks follow the same last-wins rule as the promise token: an agent that
  // drafts an assessment, keeps working, then re-emits a revised one must have
  // the revision reach the human.
  it("takes the LAST ui-impact block when several are emitted", () => {
    const out =
      "<ui-impact>draft: maybe a modal</ui-impact>\n" +
      "on reflection…\n" +
      "<ui-impact>final: full-page wizard, 3 steps invented</ui-impact>\n" +
      "<promise>NEEDS-UI-PROTOTYPE</promise>";
    expect(parsePromise(out, noCommits)).toEqual({
      kind: "NEEDS-UI-PROTOTYPE",
      uiImpact: "final: full-page wizard, 3 steps invented",
    });
  });

  it("takes the LAST questions block when several are emitted", () => {
    const out =
      "<questions>- draft Q</questions>\n" +
      "<questions>- the actual Q</questions>\n" +
      "<promise>NEEDS-INFO</promise>";
    expect(parsePromise(out, withCommits)).toEqual({
      kind: "NEEDS-INFO",
      questions: "- the actual Q",
    });
  });

  it("STILL_WORKING reprompt names all three valid tokens", () => {
    const r = parsePromise("just thinking out loud", withCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") {
      expect(r.reprompt).toContain("COMPLETE");
      expect(r.reprompt).toContain("NEEDS-INFO");
      expect(r.reprompt).toContain("NEEDS-UI-PROTOTYPE");
    }
  });

  // A token is one of the three literal strings (#113); a tag around any other
  // word is prose, so the output carries no token and the nudge — which names
  // the three valid ones — is the correction.
  it("treats an unknown token as a missing one", () => {
    const r = parsePromise("<promise>FOOBAR</promise>", withCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") {
      expect(r.missingTag).toBe(true);
      expect(r.reprompt).toContain("<promise>COMPLETE</promise>");
      expect(r.reprompt).toContain("<promise>NEEDS-INFO</promise>");
      expect(r.reprompt).toContain("<promise>NEEDS-UI-PROTOTYPE</promise>");
    }
  });

  // The #88 shape (#113): an opener quoted without a closer used to become the
  // start of the token, and the real token's closer ended it.
  it("a quoted opener without a closer does not swallow the real token", () => {
    const r = parsePromise(
      "the parser scans `/<promise>([\\s\\S]*?)<\\/promise>/g` today.\n" +
        "Committed the fix.\n<promise>COMPLETE</promise>",
      withCommits,
    );
    expect(r.kind).toBe("COMPLETE");
  });

  it("a well-formed token quoted before the real one loses to it", () => {
    const r = parsePromise(
      "the prompt asks for <promise>COMPLETE</promise> when done.\n" +
        "<questions>\nWhich?\n</questions>\n<promise>NEEDS-INFO</promise>",
      withCommits,
    );
    expect(r).toEqual({ kind: "NEEDS-INFO", questions: "Which?" });
  });

  it("a quoted block opener does not swallow the real block", () => {
    const r = parsePromise(
      "I will put them in a `<questions>` block.\n" +
        "<questions>\nWhich?\n</questions>\n<promise>NEEDS-INFO</promise>",
      withCommits,
    );
    expect(r).toEqual({ kind: "NEEDS-INFO", questions: "Which?" });
  });

  // `missingTag` is the promise nudge's licence (inner-loop.ts): only output
  // with NO tag at all qualifies for the same-conversation follow-up. A tag
  // that failed its guard means the agent remembered the contract and got the
  // substance wrong — the guard's own re-prompt is the correction, so those
  // must not carry the flag.
  describe("missingTag", () => {
    it("is set when no promise tag appears at all", () => {
      const r = parsePromise("finished everything, see the commits", withCommits);
      expect(r.kind).toBe("NO-SIGNAL");
      if (r.kind === "NO-SIGNAL") expect(r.missingTag).toBe(true);
    });

    it("is absent for a zero-commit COMPLETE", () => {
      const r = parsePromise("<promise>COMPLETE</promise>", noCommits);
      expect(r.kind).toBe("NO-SIGNAL");
      if (r.kind === "NO-SIGNAL") expect(r.missingTag).toBeUndefined();
    });

    it("is absent for NEEDS-INFO without a questions block", () => {
      const r = parsePromise("<promise>NEEDS-INFO</promise>", withCommits);
      expect(r.kind).toBe("NO-SIGNAL");
      if (r.kind === "NO-SIGNAL") expect(r.missingTag).toBeUndefined();
    });

    it("a nudge reply concatenated after the original output parses last-wins", () => {
      const original = "long summary of the work, tag forgotten";
      const nudgeReply = "<promise>COMPLETE</promise>";
      expect(parsePromise(`${original}\n${nudgeReply}`, withCommits)).toEqual({
        kind: "COMPLETE",
      });
    });

    it("a bare NEEDS-INFO nudge reply pairs with the original's questions block", () => {
      const original = "<questions>\n- which flag wins?\n</questions>\nno tag here";
      const nudgeReply = "<promise>NEEDS-INFO</promise>";
      expect(parsePromise(`${original}\n${nudgeReply}`, withCommits)).toEqual({
        kind: "NEEDS-INFO",
        questions: "- which flag wins?",
      });
    });
  });

  it("treats whitespace-padded tokens identically", () => {
    expect(parsePromise("<promise>  COMPLETE  </promise>", withCommits)).toEqual({
      kind: "COMPLETE",
    });
  });

  it("rejects NEEDS-HUMAN (not a valid agent-emitted token)", () => {
    const r = parsePromise("<promise>NEEDS-HUMAN</promise>", withCommits);
    expect(r).toMatchObject({ kind: "NO-SIGNAL", missingTag: true });
  });
});
