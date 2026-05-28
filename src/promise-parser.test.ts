import { describe, expect, it } from "vitest";
import { parsePromise } from "./promise-parser.js";

const withCommits = { commitsAccumulated: 1 } as const;
const noCommits = { commitsAccumulated: 0 } as const;

describe("parsePromise", () => {
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

  it("returns NO-SIGNAL with verbatim mention of an unknown token", () => {
    const r = parsePromise("<promise>FOOBAR</promise>", withCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") {
      expect(r.reprompt).toContain('"FOOBAR"');
      expect(r.reprompt).toContain("`COMPLETE`");
      expect(r.reprompt).toContain("`NEEDS-INFO`");
    }
  });

  it("returns NO-SIGNAL with `still working` reprompt when no promise tag is present", () => {
    const r = parsePromise("just thinking out loud", withCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") expect(r.reprompt).toContain("Still working");
  });

  it("treats whitespace-padded tokens identically", () => {
    expect(parsePromise("<promise>  COMPLETE  </promise>", withCommits)).toEqual({
      kind: "COMPLETE",
    });
  });

  it("rejects token with extra content (NEEDS-HUMAN is not a valid agent-emitted token)", () => {
    const r = parsePromise("<promise>NEEDS-HUMAN</promise>", withCommits);
    expect(r.kind).toBe("NO-SIGNAL");
    if (r.kind === "NO-SIGNAL") expect(r.reprompt).toContain('"NEEDS-HUMAN"');
  });
});
