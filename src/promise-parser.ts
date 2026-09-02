// Promise-token parser.
//
// The agent signals state with a single `<promise>TOKEN</promise>` tag:
// `COMPLETE`, `NEEDS-INFO` (paired with a `<questions>` block) or
// `NEEDS-UI-PROTOTYPE` (#21, paired with a `<ui-impact>` block). Anything else
// is a no-signal — the inner loop keeps going, optionally with a re-prompt
// hint payload that the next attempt's prompt should include.
//
// `missingTag` marks the one NO-SIGNAL flavour where NO tag was emitted at
// all, as opposed to a tag that failed its guard. The distinction is the inner
// loop's licence for the promise nudge: no tag is overwhelmingly a finished
// agent that forgot the contract, worth one cheap same-conversation follow-up
// before it costs a full attempt; a failed guard means the agent got the
// substance wrong, and the guard's specific re-prompt is the correction.
//
// NEEDS-UI-PROTOTYPE is deliberately NOT guarded on `commitsAccumulated === 0`:
// an agent often only realises it is inventing UI a few files in, and rejecting
// a late escalation would punish it for noticing. "No commits exist when this
// fires" stays a prompt-level expectation, never an invariant downstream code
// relies on (finalize handles both cases).

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

export const PROMISE_TOKENS = {
  COMPLETE: "COMPLETE",
  NEEDS_INFO: "NEEDS-INFO",
  NEEDS_UI_PROTOTYPE: "NEEDS-UI-PROTOTYPE",
} as const;

// The parser owns the implementer's token contract. The sandbox completion
// watch consumes these same renderings so adding or renaming a parsed token
// cannot silently leave the process bound by the idle timeout instead (#83).
export const PROMISE_COMPLETION_SIGNALS = [
  `<promise>${PROMISE_TOKENS.COMPLETE}</promise>`,
  `<promise>${PROMISE_TOKENS.NEEDS_INFO}</promise>`,
  `<promise>${PROMISE_TOKENS.NEEDS_UI_PROTOTYPE}</promise>`,
] as const;

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

  if (token === PROMISE_TOKENS.COMPLETE) {
    if (ctx.commitsAccumulated === 0) {
      return { kind: "NO-SIGNAL", reprompt: COMPLETE_NO_COMMITS };
    }
    return { kind: "COMPLETE" };
  }

  if (token === PROMISE_TOKENS.NEEDS_INFO) {
    const questions = lastBlock(stdout, "questions");
    if (!questions) {
      return { kind: "NO-SIGNAL", reprompt: NEEDS_INFO_NO_QUESTIONS };
    }
    return { kind: "NEEDS-INFO", questions };
  }

  if (token === PROMISE_TOKENS.NEEDS_UI_PROTOTYPE) {
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
