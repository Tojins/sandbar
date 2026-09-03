// Token scanning — the one spelling of "find the agent's tag in its output"
// that the verdict, promise and resolve-signal parsers share (#113).
//
// The agents signal with paired tags — `<verdict>APPROVED</verdict>`,
// `<promise>COMPLETE</promise>` — inside free prose that quotes the very code
// defining those tags. The parsers used to scan with `<tag>([\s\S]*?)</tag>`,
// whose non-greedy payload starts at the FIRST opener the scanner reaches and
// runs to the NEXT closer, whatever lies between. An opener quoted in prose
// without a closer of its own — a regex literal whose closer is escaped, an
// unclosed mention — therefore became the start of the token, the real token's
// closer ended it, and the payload was a page of prose. That is how #88's
// round 8, an approving review that quoted the strip regex, was parsed as
// CHANGES-REQUESTED and spent the issue's last review round.
//
// Two shapes close it, and no parser may spell a third:
//   - `literalTokenPattern`: a token is exactly one of the strings the prompt
//     asks for, whitespace tolerated inside the tag. Anything else is not a
//     token — a quoted opener, a malformed casing, an empty tag are prose.
//     Every SIGNAL parser scans with this; last well-formed token wins, so a
//     token quoted before the real one still loses to it.
//   - `temperedBlockPattern`: a free-text block (`<questions>`, `<reason>`)
//     cannot be literal-matched, so its payload is instead forbidden from
//     crossing another opener of the same tag. A quoted opener then fails to
//     match rather than swallowing the block that follows.
//
// Both return a fresh global regex per call: `matchAll` requires the `g` flag
// and a shared instance would leak `lastIndex` between parses.

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function literalTokenPattern(
  tag: string,
  tokens: readonly string[],
): RegExp {
  const alternation = tokens.map(escape).join("|");
  return new RegExp(`<${tag}>\\s*(${alternation})\\s*</${tag}>`, "g");
}

export function temperedBlockPattern(tag: string): RegExp {
  return new RegExp(`<${tag}>((?:(?!<${tag}>)[\\s\\S])*?)</${tag}>`, "g");
}

// The payload of the last well-formed token, or null when the output carries
// none. `pattern` must come from one of the builders above.
export function lastToken(stdout: string, pattern: RegExp): string | null {
  const matches = [...stdout.matchAll(pattern)];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  return (last[1] ?? "").trim();
}
