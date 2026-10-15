// When tracker reads may resume after GitHub refused one for quota.
//
// A planning `gh` read that hits the rate limit (`isForgeRateLimit`) used to
// halt the daemon like any other forge answer, and a restart only spends the
// next request on the same refusal. run.ts now holds every tracker read until
// the instant this module names, then plans again; running work, terminals
// and a latched restart keep their usual wake handling meanwhile.
//
// The instant comes from `gh api rate_limit`, which GitHub serves without
// charging it against any quota and which still answers while one is spent:
// the latest `reset` among the resources at `remaining: 0`. A secondary
// (abuse) limit leaves every resource with quota, and a failed or malformed
// answer says nothing, so both fall back to a fixed hold. Retrying sooner
// is not merely wasted: GitHub warns that requests sent while limited can get
// the token blocked for longer.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { hasExitCode } from "./errors.js";

const exec = promisify(execFile);

// Long enough for a secondary limit, which GitHub asks callers to back off
// from for at least a minute.
export const RATE_LIMIT_FALLBACK_HOLD_MS = 5 * 60_000;
// A reset read from the response is trusted only this far ahead; the primary
// window is one hour, so anything later is a malformed answer.
export const RATE_LIMIT_MAX_HOLD_MS = 65 * 60_000;
// Clock skew and GitHub's own second granularity.
const RESET_MARGIN_MS = 5_000;

// Pure: the resume instant (epoch ms) for a `rate_limit` response body, or
// for `null` when there was none.
export function rateLimitResumeAt(body: unknown, nowMs: number): number {
  const fallback = nowMs + RATE_LIMIT_FALLBACK_HOLD_MS;
  const resources = (body as { resources?: unknown } | null)?.resources;
  if (typeof resources !== "object" || resources === null) return fallback;
  let latest: number | null = null;
  for (const resource of Object.values(resources)) {
    const { remaining, reset } = (resource ?? {}) as {
      remaining?: unknown;
      reset?: unknown;
    };
    if (remaining !== 0 || typeof reset !== "number") continue;
    const at = reset * 1000 + RESET_MARGIN_MS;
    if (latest === null || at > latest) latest = at;
  }
  if (latest === null || latest <= nowMs) return fallback;
  return Math.min(latest, nowMs + RATE_LIMIT_MAX_HOLD_MS);
}

export async function fetchRateLimitResumeAt(nowMs: number): Promise<number> {
  try {
    const { stdout } = await exec("gh", ["api", "rate_limit"]);
    return rateLimitResumeAt(JSON.parse(stdout), nowMs);
  } catch (err) {
    // Only a `gh` that answered nonzero or with a body that is not JSON is
    // "no answer"; anything else is a bug and propagates.
    if (!hasExitCode(err) && !(err instanceof SyntaxError)) throw err;
    return rateLimitResumeAt(null, nowMs);
  }
}
