// Real-Git contract tests for the repository-wide origin ref lock (#139).
//
// The unit suite pins every argv and decision. These cases pin the property no
// fake can: a bare origin serializes the expected-absent/expected-sha updates,
// including two independent caches racing to become the first holder.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ORIGIN_LOCK_REF,
  OriginLockHeldError,
  acquireOriginLock,
  type OriginLockHandle,
  type OriginLockIdentity,
} from "./origin-lock.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

let root: string;
let origin: string;
let cacheA: string;
let cacheB: string;
const locks: OriginLockHandle[] = [];

const identity = (hostname: string): OriginLockIdentity => ({
  hostname,
  workdir: join(root, hostname, ".sandbar"),
  pid: hostname === "host-a" ? 101 : 202,
  run: `${hostname}-run`,
  startedAt: "2026-09-08T12:00:00.000Z",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sandbar-origin-lock-"));
  origin = join(root, "origin.git");
  cacheA = join(root, "cache-a.git");
  cacheB = join(root, "cache-b.git");
  await exec("git", ["init", "--bare", "-q", origin]);
  await exec("git", ["init", "--bare", "-q", cacheA]);
  await exec("git", ["init", "--bare", "-q", cacheB]);
  await git(cacheA, "remote", "add", "origin", origin);
  await git(cacheB, "remote", "add", "origin", origin);
});

afterEach(async () => {
  while (locks.length > 0) await locks.pop()?.release().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("origin ref lease against a bare remote", () => {
  it("acquires, renews and CAS-deletes the ref", async () => {
    let clock = Date.parse("2026-09-08T12:00:00.000Z");
    const acquired = await acquireOriginLock({
      repoDir: cacheA,
      identity: identity("host-a"),
      now: () => new Date(clock),
    });
    locks.push(acquired.lock);
    const first = acquired.lock.claim().sha;
    await expect(git(origin, "show-ref", "--verify", ORIGIN_LOCK_REF))
      .resolves.toBeDefined();
    const parents = await git(origin, "rev-list", "--parents", "-n", "1", first);
    expect(parents.stdout.trim().split(/\s+/)).toEqual([first]);
    expect((await git(origin, "ls-tree", first)).stdout).toBe("");

    clock += 60_000;
    await expect(acquired.lock.renew()).resolves.toMatchObject({ kind: "renewed" });
    expect(acquired.lock.claim().sha).not.toBe(first);

    await acquired.lock.release();
    locks.pop();
    await expect(git(origin, "show-ref", "--verify", ORIGIN_LOCK_REF))
      .rejects.toBeDefined();
  });

  it("allows exactly one of two concurrent absent-ref acquirers", async () => {
    const attempts = await Promise.allSettled([
      acquireOriginLock({ repoDir: cacheA, identity: identity("host-a") }),
      acquireOriginLock({ repoDir: cacheB, identity: identity("host-b") }),
    ]);
    const winners = attempts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireOriginLock>>> =>
        result.status === "fulfilled",
    );
    const losers = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toBeInstanceOf(OriginLockHeldError);
    if (winners[0]) locks.push(winners[0].value.lock);
  });

  it("takes over an expired lease and the old holder observes loss", async () => {
    let firstClock = Date.parse("2026-09-08T12:00:00.000Z");
    const first = await acquireOriginLock({
      repoDir: cacheA,
      identity: identity("host-a"),
      now: () => new Date(firstClock),
    });
    locks.push(first.lock);

    const second = await acquireOriginLock({
      repoDir: cacheB,
      identity: identity("host-b"),
      now: () => new Date(firstClock + 11 * 60_000),
    });
    locks.push(second.lock);
    expect(second.displaced?.lease.hostname).toBe("host-a");

    firstClock += 11 * 60_000;
    await expect(first.lock.renew()).resolves.toMatchObject({
      kind: "lost",
      reason: "replaced",
      holder: { lease: { hostname: "host-b" } },
    });
  });
});
