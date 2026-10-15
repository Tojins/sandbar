import { describe, expect, it } from "vitest";

import { isForgeRateLimit } from "./errors.js";
import {
  RATE_LIMIT_FALLBACK_HOLD_MS,
  RATE_LIMIT_MAX_HOLD_MS,
  rateLimitResumeAt,
} from "./forge-rate-limit.js";

const NOW = 1_800_000_000_000;
const resetIn = (ms: number): number => (NOW + ms) / 1000;

describe("rateLimitResumeAt", () => {
  it("waits for the latest reset among the exhausted resources", () => {
    expect(rateLimitResumeAt({
      resources: {
        core: { remaining: 0, reset: resetIn(60_000) },
        graphql: { remaining: 0, reset: resetIn(600_000) },
        search: { remaining: 3, reset: resetIn(1_200_000) },
      },
    }, NOW)).toBe(NOW + 605_000);
  });

  it.each([
    ["no answer", null],
    ["a malformed answer", { resources: "nope" }],
    ["a secondary limit (no resource exhausted)", {
      resources: { graphql: { remaining: 4000, reset: resetIn(600_000) } },
    }],
    ["a reset already past", {
      resources: { graphql: { remaining: 0, reset: resetIn(-10_000) } },
    }],
  ])("falls back to a fixed hold for %s", (_, body) => {
    expect(rateLimitResumeAt(body, NOW)).toBe(NOW + RATE_LIMIT_FALLBACK_HOLD_MS);
  });

  it("caps a reset beyond one window", () => {
    expect(rateLimitResumeAt({
      resources: { graphql: { remaining: 0, reset: resetIn(86_400_000) } },
    }, NOW)).toBe(NOW + RATE_LIMIT_MAX_HOLD_MS);
  });
});

describe("isForgeRateLimit", () => {
  const ghFailure = (stderr: string): Error =>
    Object.assign(new Error(`Command failed: gh api graphql\n${stderr}`), { code: 1, stderr });

  it.each([
    "gh: API rate limit already exceeded for user ID 326846765.\n",
    "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)\n",
    "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes.\n",
  ])("recognises %j", (stderr) => {
    expect(isForgeRateLimit(ghFailure(stderr))).toBe(true);
    expect(isForgeRateLimit(new Error("wrapped", { cause: ghFailure(stderr) }))).toBe(true);
  });

  it("reads stderr only, not the quoted argv", () => {
    expect(isForgeRateLimit(Object.assign(
      new Error("Command failed: gh issue comment --body 'API rate limit exceeded'"),
      { code: 1, stderr: "HTTP 404: Not Found\n" },
    ))).toBe(false);
  });
});
