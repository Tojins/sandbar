// The landing window (#244): weekly hours during which sandbar lands nothing on
// the source branch, because on an installation like outdoor a landing there
// IS a production deploy, and nobody wants one at 17:00 on a Friday.
//
// `config.landingWindow` (validated in `config.ts`) names one closed span in
// one IANA zone. This module answers the one question the daemon asks of it at
// every recompute: is it closed NOW, and if so until when (as prose a human
// reads on a pull request). Wall-clock time in the configured zone is compared,
// not UTC offsets, so "Mon 08:00" stays 08:00 across a DST change.
//
// What waits while it is closed is decided in `run.ts`, at the one place each
// kind of landing is admitted, and nowhere downstream:
//
//   * a chunk's `land` request is left out of the runnable requests and
//     reported as deferred; its pull request is told once per closure (per
//     process: a restart while closed tells it again). The label stays on,
//     so the first recompute after the window opens lands it.
//   * a chunk whose pull request carries `land-hotfix` (`chunks.ts`) is not
//     held at all. It is taken off with `land` when the chunk lands or parks.
//   * a DONE auto-lane issue — the other way a commit reaches the source
//     branch — is held in the pool (`ContinuousPool.holdTerminals`): still
//     ongoing, so nothing re-picks it, but not a pending terminal, so it does
//     not wake a landing pass. The first recompute after the window opens
//     releases it into the next landing. A process that exits while one is
//     held leaves its branch resumable (#13), as any interrupted landing does.
//
// Everything else a landing pass does is not on the source branch and goes on
// as usual: review-lane issues landing on their chunk branch, chunk refreshes,
// and the reconciler finishing a chunk a human merged by hand. The decision is
// taken when a pass is admitted; a pass already under way when the window
// closes finishes.

import { type LandingWindowSettings, WEEKDAYS } from "./config.js";

// Null when nothing holds landings now — no window configured, or outside its
// closed span — else when it reopens, e.g. `Mon 08:00 (Europe/Brussels)`.
export function landingClosedUntil(
  window: LandingWindowSettings | null,
  now: Date,
): string | null {
  if (window === null) return null;
  const minute = minuteOfWeek(window.timeZone, now);
  const from = window.closedFrom.minuteOfWeek;
  const until = window.closedUntil.minuteOfWeek;
  const closed = from < until
    ? minute >= from && minute < until
    : minute >= from || minute < until;
  return closed ? `${window.closedUntil.text} (${window.timeZone})` : null;
}

function minuteOfWeek(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) {
      throw new Error(`Intl gave no ${type} for ${now.toISOString()} in ${timeZone}`);
    }
    return value;
  };
  const day = WEEKDAYS.findIndex((weekday) => weekday === part("weekday"));
  if (day < 0) {
    throw new Error(`Intl gave an unknown weekday for ${now.toISOString()} in ${timeZone}`);
  }
  return day * 24 * 60 + Number(part("hour")) * 60 + Number(part("minute"));
}
