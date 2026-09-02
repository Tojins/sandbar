// #99 — ratchet for the two syntactic forms that historically hid failures in
// production code.  Entries disappear as files are converted; an absent file
// therefore has a budget of zero.  Keep a decrement in the same commit as the
// conversion it records.
export const ERROR_SWALLOW_BASELINE: Readonly<Record<string, number>> = {
  "merger.ts": 11,
};
