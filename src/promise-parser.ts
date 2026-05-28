// Promise-token parser.
//
// The agent signals state with a single `<promise>TOKEN</promise>` tag.
// Two tokens are valid: `COMPLETE` (claims the work is done) and `NEEDS-INFO`
// (asks the human for help, paired with a `<questions>` block). Anything else
// is a no-signal — the inner loop keeps going, optionally with a re-prompt
// hint payload that the next attempt's prompt should include.

export type ParseSignal =
  | { readonly kind: "COMPLETE" }
  | { readonly kind: "NEEDS-INFO"; readonly questions: string }
  | { readonly kind: "NO-SIGNAL"; readonly reprompt?: string };

export type ParseContext = {
  readonly commitsAccumulated: number;
};

const STILL_WORKING =
  "Still working. Emit `<promise>COMPLETE</promise>` when the implementation " +
  "is done and committed, or `<promise>NEEDS-INFO</promise>` with a " +
  "`<questions>` block if you are blocked on missing information.";

const COMPLETE_NO_COMMITS =
  "You declared `<promise>COMPLETE</promise>` but made no commits this run. " +
  "Implement the change — don't just analyze. Commit your work and re-emit " +
  "the promise.";

const NEEDS_INFO_NO_QUESTIONS =
  "You declared `<promise>NEEDS-INFO</promise>` but no `<questions>` block " +
  "was provided. Either include the specific questions you need answered, " +
  "or continue implementing.";

export function parsePromise(
  stdout: string,
  ctx: ParseContext,
): ParseSignal {
  const matches = [...stdout.matchAll(/<promise>([\s\S]*?)<\/promise>/g)];
  if (matches.length === 0) {
    return { kind: "NO-SIGNAL", reprompt: STILL_WORKING };
  }

  const last = matches[matches.length - 1]!;
  const token = (last[1] ?? "").trim();

  if (token === "COMPLETE") {
    if (ctx.commitsAccumulated === 0) {
      return { kind: "NO-SIGNAL", reprompt: COMPLETE_NO_COMMITS };
    }
    return { kind: "COMPLETE" };
  }

  if (token === "NEEDS-INFO") {
    const qm = stdout.match(/<questions>([\s\S]*?)<\/questions>/);
    if (!qm || !qm[1] || !qm[1].trim()) {
      return { kind: "NO-SIGNAL", reprompt: NEEDS_INFO_NO_QUESTIONS };
    }
    return { kind: "NEEDS-INFO", questions: qm[1].trim() };
  }

  return {
    kind: "NO-SIGNAL",
    reprompt:
      `Unknown promise token: "${token}". Only \`COMPLETE\` and \`NEEDS-INFO\` ` +
      "are valid. Continue working.",
  };
}
