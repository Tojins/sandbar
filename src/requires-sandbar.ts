// The sandbar version a config was written for (#66).
//
// The seam this closes is one that PINNING the driver creates. A self-hosted
// run is no longer driven by a build of the operator's working tree: it runs an
// installed release — `.sandbar/driver/`, at the tag `sandbar.pin` names — while
// the config file stays in the checkout, where it moves whenever a human edits
// it or pulls. The two are therefore no longer two views of one tree, and the
// routine skew is the one direction that matters: a config NEWER than the
// driver reading it.
//
// Untreated, that skew is silent and total. `loadConfig` casts the module's
// default export unchecked (cli.ts), `resolveConfig` spreads unknown keys
// through verbatim, and nothing downstream reads a key it does not know about,
// so a field written for a newer sandbar is dropped without a word — a
// `gateStack` step the driver never runs, a lane it never honours. Nor is it
// only additions: `resolveMergeMode` read ANY unrecognised `kind` as the
// verified shape, so a third mode a newer sandbar defined would have been run
// as verified mode against a config that never described one. (That one is
// fixed where it lives, in `config.ts`; this module is the general instrument.)
//
// An unknown-key allowlist is deliberately NOT that instrument. The config is a
// PROGRAM and a host may legitimately carry extra data in it — a computed tag,
// a table it maps into `gateStack`, a note to the next reader — so rejecting
// keys sandbar does not recognise would outlaw the file's whole point to buy a
// check the config can simply state. The config declares its floor; the driver
// compares itself against it and refuses.
//
// A MINIMUM, not a range, and one spelling of it: `X.Y.Z`, exactly as
// `package.json` writes it. The only question a config can usefully answer is
// "how old a sandbar stops being able to read me", and answering it needs no
// resolver, no dependency and no second dialect for an operator to get wrong.
// A range would also invite an upper bound, which is a promise a config cannot
// keep: it cannot know what a later version does.
//
// OPTIONAL, and that is not a hedge. Requiring the field would break every
// config already written against a released sandbar — the exact silent-skew
// failure this exists to prevent, inflicted deliberately on every consumer, and
// #66 changes no library contract. A config that omits it gets no protection
// and that is the host's call; a config that names one gets a refusal instead
// of a half-read. This repo's own config names one, because this repo is where
// driver and config genuinely come from different commits.
//
// REFUSES on a driver whose own version cannot be parsed, "unknown" included.
// `sandbarVersion()` degrades to "unknown" when `package.json` cannot be read,
// which is a fine answer for a container-reuse token and the wrong one here:
// the check exists to prove a floor is met, and a driver that cannot say what
// it is has not met it. Loud beats a run judged by an unidentifiable driver.

import { SandbarError } from "./errors.js";

export type SemVer = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

// `null` for anything that is not exactly three dot-separated runs of digits.
// No leading `v`, no prerelease, no build metadata: `package.json`'s `version`
// is the value being compared, and every spelling that is not that one is a
// config the operator has to look at rather than one to guess the intent of.
export function parseVersion(raw: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// Negative when `a` is older than `b`, 0 when equal, positive when newer.
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

// Throws SandbarError, which is what `resolveConfig`'s other validation throws
// and therefore lands on the bin's fault printer BEFORE the lock, preflight or
// any container exists — a config the driver cannot read must cost nothing but
// the message.
export function checkRequiresSandbar(
  required: string | undefined,
  driverVersion: string,
): void {
  if (required === undefined) return;
  if (typeof required !== "string") {
    throw new SandbarError(
      `config.requiresSandbar must be a version string like "1.4.0" (got ` +
        `${required === null ? "null" : typeof required}). It is the OLDEST ` +
        "sandbar that can read this config; the driver refuses the run when it " +
        "is older than that.",
    );
  }
  const floor = parseVersion(required);
  if (!floor) {
    throw new SandbarError(
      `config.requiresSandbar must be a plain X.Y.Z version (got ` +
        `${JSON.stringify(required)}). It is a MINIMUM, not a range: no ` +
        'comparator ("^1.2.0", ">=1.2.0"), no leading "v", no prerelease ' +
        "suffix — write it exactly as `package.json` does.",
    );
  }
  const driver = parseVersion(driverVersion);
  if (!driver) {
    throw new SandbarError(
      `config.requiresSandbar is ${JSON.stringify(required)}, and this driver ` +
        `cannot say which version it is (${JSON.stringify(driverVersion)}). ` +
        "The check exists to prove that floor is met, so an unidentifiable " +
        "driver fails it. Sandbar reads its own version from the `package.json` " +
        "beside `dist/`; an install missing that file is the usual cause.",
    );
  }
  if (compareVersions(driver, floor) >= 0) return;
  throw new SandbarError(
    `This config requires sandbar ${required} or newer, and the driver is ` +
      `${driverVersion}.\n` +
      "Sandbar refuses rather than reading the config half-way: fields written " +
      "for a newer version are not rejected anywhere downstream, they are " +
      "silently ignored, so a gate step or a lane this file asks for would " +
      "simply never happen.\n" +
      "Either move the driver forward (for a self-hosted repo that is the pin " +
      "in `sandbar.pin`; for a consumer, the installed version of " +
      "@offergeist/sandbar), or lower `requiresSandbar` to a version this " +
      "config is actually written for.",
  );
}
