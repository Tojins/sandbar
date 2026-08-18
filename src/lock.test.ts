// Real-filesystem tests for the single-instance lock.
//
// Both properties here are load-bearing for decisions made elsewhere, and
// neither is visible in lock.ts's own types:
//
//   - The acquire is NON-BLOCKING (`retries: 0`). #32 moved preflight inside
//     the lock on the argument that ordering it that way costs nothing —
//     which is true only while a held lock fails immediately. Add retries and
//     that argument silently becomes false: every config typo in a second
//     launch would then pay a wait before being told anything.
//   - The stale-PID sidecar takes over from a DEAD holder without waiting for
//     proper-lockfile's own staleness window (10s of mtime age), which is what
//     makes a crashed run recoverable on the next launch rather than on a
//     timer.
//
// Exercised against a real temp dir rather than a fake, for the usual reason:
// a fake satisfies the contract no matter what proper-lockfile does.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LockHeldError, acquireLock, lockPathsFor } from "./lock.js";

let dir: string;
const releases: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbar-lock-"));
});

afterEach(async () => {
  while (releases.length > 0) {
    const release = releases.pop();
    if (release) await release().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

async function take(paths: ReturnType<typeof lockPathsFor>) {
  const release = await acquireLock(paths);
  releases.push(release);
  return release;
}

// A pid that has certainly exited: spawnSync returns only after the child is
// reaped, so by the time we read `.pid` there is no such process. (Linux hands
// out pids monotonically, so reuse this soon after is not a real hazard.)
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  expect(pid).toBeTypeOf("number");
  return pid as number;
}

describe("lockPathsFor", () => {
  it("puts both files inside the workdir it is given", () => {
    const paths = lockPathsFor("/some/work/dir");
    expect(paths.workDir).toBe("/some/work/dir");
    expect(paths.lockPath).toBe(join("/some/work/dir", "run.lock"));
    expect(paths.pidPath).toBe(join("/some/work/dir", "run.pid"));
  });
});

describe("acquireLock", () => {
  it("creates the workdir and records the holding pid", async () => {
    const paths = lockPathsFor(join(dir, "nested", ".sandbar"));
    await take(paths);
    expect(readFileSync(paths.pidPath, "utf8")).toBe(String(process.pid));
  });

  it("refuses a second holder with LockHeldError, without waiting", async () => {
    const paths = lockPathsFor(join(dir, ".sandbar"));
    await take(paths);

    const started = process.hrtime.bigint();
    await expect(acquireLock(paths)).rejects.toBeInstanceOf(LockHeldError);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // `retries: 0`. The bound is deliberately loose — it is there to fail if
    // someone introduces a retry/backoff, not to measure the filesystem.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("names the lock path in the refusal, so the operator can find it", async () => {
    const paths = lockPathsFor(join(dir, ".sandbar"));
    await take(paths);
    await expect(acquireLock(paths)).rejects.toThrow(paths.lockPath);
  });

  it("re-acquires after release, and the release clears the pid sidecar", async () => {
    const paths = lockPathsFor(join(dir, ".sandbar"));
    const release = await take(paths);
    await release();
    releases.pop();

    expect(existsSync(paths.pidPath)).toBe(false);
    await take(paths);
  });

  it("takes over a lock whose recorded pid is dead", async () => {
    const paths = lockPathsFor(join(dir, ".sandbar"));
    await take(paths);
    // Impersonate a crashed run: the lock dir is still there and fresh (so
    // proper-lockfile's own mtime staleness has not fired), but nobody holds it.
    writeFileSync(paths.pidPath, String(deadPid()));

    await take(paths);
    expect(readFileSync(paths.pidPath, "utf8")).toBe(String(process.pid));
  });

  it("does NOT take over from a live holder whose pid is recorded", async () => {
    const paths = lockPathsFor(join(dir, ".sandbar"));
    await take(paths);
    // process.pid is alive by construction — the sidecar must not tempt the
    // takeover path into unlocking a lock that is genuinely held.
    writeFileSync(paths.pidPath, String(process.pid));
    await expect(acquireLock(paths)).rejects.toBeInstanceOf(LockHeldError);
  });

  it("leaves a live holder alone when the sidecar is unreadable garbage", async () => {
    const paths = lockPathsFor(join(dir, ".sandbar"));
    await take(paths);
    // A truncated/corrupt sidecar is not evidence of death. Fail closed.
    writeFileSync(paths.pidPath, "not-a-pid");
    await expect(acquireLock(paths)).rejects.toBeInstanceOf(LockHeldError);
  });
});
