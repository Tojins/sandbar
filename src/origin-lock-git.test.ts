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
  ORIGIN_LOCK_OBSERVED_REF,
  ORIGIN_LOCK_REF,
  OriginLockCommandError,
  OriginLockHeldError,
  acquireOriginLock,
  type OriginLockHandle,
  type OriginLockIdentity,
  type OriginLockExec,
} from "./origin-lock.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
const gitExec: OriginLockExec = async (file, args, options) => {
  try {
    const result = await exec(file, [...args], { cwd: options.cwd, env: options.env });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    const failure = cause as { code?: unknown; stderr?: unknown; message?: unknown };
    throw new OriginLockCommandError(
      typeof failure.stderr === "string" && failure.stderr.trim()
        ? failure.stderr.trim()
        : String(failure.message ?? cause),
      typeof failure.code === "number" ? failure.code : undefined,
      cause,
    );
  }
};

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
  try {
    while (locks.length > 0) {
      const lock = locks.pop();
      if (lock) await lock.release();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

  it("rejects a renewal CAS when takeover occurs after its lookup", async () => {
    let clock = Date.parse("2026-09-08T12:00:00.000Z");
    let raced = false;
    let pushes = 0;
    let winner: OriginLockHandle | null = null;
    const racingExec: OriginLockExec = async (file, args, options) => {
      if (args[0] === "push") pushes += 1;
      if (!raced && pushes === 2) {
        // Interpose a second real-Git acquirer immediately before the first
        // holder's renewal CAS reaches the bare origin.
        raced = true;
        const takeover = await acquireOriginLock({
          repoDir: cacheB,
          identity: identity("host-b"),
          now: () => new Date(clock + 11 * 60_000),
        });
        winner = takeover.lock;
        locks.push(takeover.lock);
      }
      return gitExec(file, args, options);
    };
    const first = await acquireOriginLock({
      repoDir: cacheA,
      identity: identity("host-a"),
      now: () => new Date(clock),
      exec: racingExec,
    });
    locks.push(first.lock);

    clock += 60_000;
    await expect(first.lock.renew()).resolves.toMatchObject({
      kind: "lost",
      reason: "replaced",
      holder: { lease: { hostname: "host-b" } },
    });
    expect(raced).toBe(true);
    expect(winner).not.toBeNull();
  });

  it("reads a replacement from its private ref when another fetch overwrites FETCH_HEAD", async () => {
    let clock = Date.parse("2026-09-08T12:00:00.000Z");
    let interpose = false;
    let clobbered = false;
    const isolatedExec: OriginLockExec = async (file, args, options) => {
      const result = await gitExec(file, args, options);
      if (
        interpose &&
        !clobbered &&
        args[0] === "fetch" &&
        args[3] === `+${ORIGIN_LOCK_REF}:${ORIGIN_LOCK_OBSERVED_REF}`
      ) {
        clobbered = true;
        await git(cacheA, "fetch", "--quiet", "origin", "refs/heads/main");
      }
      return result;
    };
    const first = await acquireOriginLock({
      repoDir: cacheA,
      identity: identity("host-a"),
      now: () => new Date(clock),
      exec: isolatedExec,
    });
    locks.push(first.lock);
    const firstSha = first.lock.claim().sha;

    const second = await acquireOriginLock({
      repoDir: cacheB,
      identity: identity("host-b"),
      now: () => new Date(clock + 11 * 60_000),
    });
    locks.push(second.lock);
    await git(cacheA, "push", "--quiet", "origin", `${firstSha}:refs/heads/main`);

    clock += 11 * 60_000;
    interpose = true;
    await expect(first.lock.renew()).resolves.toMatchObject({
      kind: "lost",
      reason: "replaced",
      holder: { lease: { hostname: "host-b" } },
    });
    expect(clobbered).toBe(true);
    expect((await git(cacheA, "rev-parse", "FETCH_HEAD")).stdout.trim()).toBe(firstSha);
    expect((await git(cacheA, "rev-parse", ORIGIN_LOCK_OBSERVED_REF)).stdout.trim())
      .toBe(second.lock.claim().sha);
  });
});
