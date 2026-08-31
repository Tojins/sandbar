// Promise-token parser.
//
// The agent signals state with a single `<promise>TOKEN</promise>` tag.
// Three tokens are valid: `COMPLETE` (claims the work is done), `NEEDS-INFO`
// (asks the human for help, paired with a `<questions>` block) and
// `NEEDS-UI-PROTOTYPE` (#21 — the issue implies non-trivial user-visible UI and
// carries no prototype, paired with a `<ui-impact>` block). Anything else is a
// no-signal — the inner loop keeps going, optionally with a re-prompt hint
// payload that the next attempt's prompt should include.
//
// `missingTag` marks the one NO-SIGNAL flavour where NO tag was emitted at
// all, as opposed to a tag that failed its guard (unknown token, COMPLETE
// with zero commits, an escalation missing its block). The distinction is the
// inner loop's licence for the promise nudge: output that ends with no tag is
// overwhelmingly a finished agent that forgot the contract at the end of a
// long session — both observed cases were the two longest sessions of a run —
// and is worth one cheap same-conversation follow-up before it costs a full
// attempt. A tag that failed its guard is the opposite case: the agent
// remembered the contract and got the substance wrong, and the guard's
// specific re-prompt is the correction it needs.
//
// NEEDS-UI-PROTOTYPE is deliberately NOT guarded on `commitsAccumulated === 0`
// (the mirror image of the COMPLETE guard). The prompt asks for the assessment
// before any code is written, but an agent often only realises it is inventing
// UI a few files in — and that is exactly when we most want it to stop.
// Rejecting a late escalation would punish it for noticing, so "no commits
// exist when this fires" stays a prompt-level expectation, never an invariant
// downstream code relies on (finalize handles both cases).

export type ParseSignal =
  | { readonly kind: "COMPLETE" }
  | { readonly kind: "NEEDS-INFO"; readonly questions: string }
  | { readonly kind: "NEEDS-UI-PROTOTYPE"; readonly uiImpact: string }
  | {
      readonly kind: "NO-SIGNAL";
      readonly reprompt?: string;
      readonly missingTag?: true;
    };

export type ParseContext = {
  readonly commitsAccumulated: number;
};

const STILL_WORKING =
  "Still working. Emit `<promise>COMPLETE</promise>` when the implementation " +
  "is done and committed, `<promise>NEEDS-INFO</promise>` with a " +
  "`<questions>` block if you are blocked on missing information, or " +
  "`<promise>NEEDS-UI-PROTOTYPE</promise>` with a `<ui-impact>` block if the " +
  "work turns out to imply user-visible UI with no prototype to build from.";

const COMPLETE_NO_COMMITS =
  "You declared `<promise>COMPLETE</promise>` but made no commits this run. " +
  "Implement the change — don't just analyze. Commit your work and re-emit " +
  "the promise.";

const NEEDS_INFO_NO_QUESTIONS =
  "You declared `<promise>NEEDS-INFO</promise>` but no `<questions>` block " +
  "was provided. Either include the specific questions you need answered, " +
  "or continue implementing.";

const NEEDS_UI_PROTOTYPE_NO_IMPACT =
  "You declared `<promise>NEEDS-UI-PROTOTYPE</promise>` but no `<ui-impact>` " +
  "block was provided. Either include the assessment — what visible UI this " +
  "change would create or alter, which design decisions you would be " +
  "inventing, and what artifact would unblock you — or continue implementing.";

// Last occurrence of a paired block, trimmed; "" when absent or blank. Last —
// not first — for the same reason the promise token is last-wins: an agent that
// drafts a block, keeps working, then re-emits a revised one must have the
// revision reach the human, not the draft it superseded.
function lastBlock(stdout: string, tag: string): string {
  const matches = [
    ...stdout.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")),
  ];
  const last = matches[matches.length - 1];
  return (last?.[1] ?? "").trim();
}

export function parsePromise(
  stdout: string,
  ctx: ParseContext,
): ParseSignal {
  const matches = [...stdout.matchAll(/<promise>([\s\S]*?)<\/promise>/g)];
  if (matches.length === 0) {
    return { kind: "NO-SIGNAL", reprompt: STILL_WORKING, missingTag: true };
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
    const questions = lastBlock(stdout, "questions");
    if (!questions) {
      return { kind: "NO-SIGNAL", reprompt: NEEDS_INFO_NO_QUESTIONS };
    }
    return { kind: "NEEDS-INFO", questions };
  }

  if (token === "NEEDS-UI-PROTOTYPE") {
    const uiImpact = lastBlock(stdout, "ui-impact");
    if (!uiImpact) {
      return { kind: "NO-SIGNAL", reprompt: NEEDS_UI_PROTOTYPE_NO_IMPACT };
    }
    return { kind: "NEEDS-UI-PROTOTYPE", uiImpact };
  }

  return {
    kind: "NO-SIGNAL",
    reprompt:
      `Unknown promise token: "${token}". Only \`COMPLETE\`, \`NEEDS-INFO\` ` +
      "and `NEEDS-UI-PROTOTYPE` are valid. Continue working.",
  };
}
