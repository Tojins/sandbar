// Real-filesystem tests for the single-instance lock.
//
// The properties here are load-bearing for decisions made elsewhere, and none
// of them is visible in lock.ts's types:
//
//   - The acquire is NON-BLOCKING (`retries: 0`). #32 moved preflight inside
//     the lock on the argument that ordering it that way costs nothing — which
//     is true only while a held lock fails immediately. Add retries and that
//     argument silently becomes false: every config typo in a second launch
//     would then pay a wait before being told anything.
//   - The stale-PID sidecar takes over from a DEAD holder without waiting out
//     proper-lockfile's own staleness window (10s of mtime age), which is what
//     makes a crashed run recoverable on the next launch rather than on a timer.
//   - It does NOT take over from a live one, or on a sidecar it cannot read.
//
// The takeover tests spawn a REAL second process and kill it, rather than
// locking twice in-process. That is not thoroughness, it is the only version of
// the test that means anything: an in-process holder populates
// proper-lockfile's module-level lock registry, which is the one arrangement in
// which the old `lockfile.unlock`-based takeover worked. It certified a
// recovery path that could not fire in production, where the dead holder is by
// definition another process. Anything here that pins the takeover must cross a
// process boundary or it is pinning the bug.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LockHeldError, acquireLock, lockPathsFor } from "./lock.js";

let dir: string;
const releases: Array<() => Promise<void>> = [];
const children: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbar-lock-"));
});

afterEach(async () => {
  while (children.length > 0) children.pop()?.();
  while (releases.length > 0) {
    const release = releases.pop();
    if (release) await release().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

function paths() {
  return lockPathsFor(join(dir, ".sandbar"));
}

async function take(p: ReturnType<typeof lockPathsFor>) {
  const release = await acquireLock(p);
  releases.push(release);
  return release;
}

// proper-lockfile's on-disk lock, so tests can assert on the thing itself
// rather than only on acquireLock's answer about it.
function lockDirExists(p: ReturnType<typeof lockPathsFor>): boolean {
  return existsSync(`${p.lockPath}.lock`);
}

// Source for a child that acquires the lock, announces it, then either dies
// hard (SIGKILL — no exit handler runs, so proper-lockfile's dir is left behind
// exactly as a crashed run leaves it) or stays alive holding it. The `hold`
// child must PARK on a real HANDLE: a never-resolving promise does not keep the
// loop alive (node exits 13 on it), and falling off the end exits normally,
// which fires proper-lockfile's exit handler and releases the very lock the
// test needs held — silently, since the parent has already seen "locked".
function childSource(workDir: string, mode: "crash" | "hold"): string {
  const lockModule = fileURLToPath(new URL("./lock.ts", import.meta.url));
  return `
    import { acquireLock, lockPathsFor } from ${JSON.stringify(lockModule)};
    await acquireLock(lockPathsFor(${JSON.stringify(workDir)}));
    console.log("locked");
    ${
      mode === "crash"
        ? 'process.kill(process.pid, "SIGKILL");'
        : "setInterval(() => {}, 1000);"
    }
  `;
}

// Plain `node`, importing lock.ts's SOURCE — node strips the types itself. A
// small loader maps its ESM `.js` import back to errors.ts, as the test runner
// does. Deliberately not dist/: a test that pins the module under test must not
// be able to pass against a stale compile of it.
function spawnHolder(workDir: string, mode: "crash" | "hold"): Promise<void> {
  const file = join(dir, `holder-${mode}.mts`);
  const loader = join(dir, "source-loader.mjs");
  const errorsJs = new URL("./errors.js", import.meta.url).href;
  const errorsTs = new URL("./errors.ts", import.meta.url).href;
  writeFileSync(
    loader,
    `export async function resolve(specifier, context, nextResolve) {
      if (specifier === "./errors.js" || specifier === ${JSON.stringify(errorsJs)}) {
        return { url: ${JSON.stringify(errorsTs)}, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }`,
  );
  writeFileSync(file, childSource(workDir, mode));
  const child = spawn(process.execPath, ["--loader", loader, file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(() => child.kill("SIGKILL"));
  return new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    // `hold` is ready once it says so. `crash` is ready only once it has been
    // REAPED: "locked" reaches us before the SIGKILL lands, and probing then
    // finds the holder still alive, so the takeover correctly declines and the
    // test fails on a race of its own making.
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      if (mode === "hold" && out.includes("locked")) resolve();
    });
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("exit", () => {
      if (!out.includes("locked")) {
        reject(new Error(`holder never locked. stderr:\n${err}`));
      } else if (mode === "crash") {
        resolve();
      } else {
        reject(new Error("holder exited instead of holding the lock"));
      }
    });
  });
}

describe("lockPathsFor", () => {
  it("puts both files inside the workdir it is given", () => {
    const p = lockPathsFor("/some/work/dir");
    expect(p.workDir).toBe("/some/work/dir");
    expect(p.lockPath).toBe(join("/some/work/dir", "run.lock"));
    expect(p.pidPath).toBe(join("/some/work/dir", "run.pid"));
  });
});

describe("acquireLock", () => {
  it("creates the workdir and records the holding pid", async () => {
    const p = lockPathsFor(join(dir, "nested", ".sandbar"));
    await take(p);
    expect(readFileSync(p.pidPath, "utf8")).toBe(String(process.pid));
  });

  it("refuses a second holder with LockHeldError, without waiting", async () => {
    const p = paths();
    await take(p);

    const started = process.hrtime.bigint();
    await expect(acquireLock(p)).rejects.toBeInstanceOf(LockHeldError);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // `retries: 0`. The bound is deliberately loose — it is there to fail if
    // someone introduces a retry/backoff (`retry`'s own default first backoff
    // is 1000ms), not to measure the filesystem.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("names the lock path in the refusal, so the operator can find it", async () => {
    const p = paths();
    await take(p);
    await expect(acquireLock(p)).rejects.toThrow(p.lockPath);
  });

  it("re-acquires after release, and the release clears the pid sidecar", async () => {
    const p = paths();
    const release = await take(p);
    await release();
    releases.pop();

    expect(existsSync(p.pidPath)).toBe(false);
    await take(p);
  });

  it("releases the real lock when removing the pid sidecar fails", async () => {
    const p = paths();
    const release = await take(p);
    releases.pop();
    rmSync(p.pidPath);
    mkdirSync(p.pidPath);

    await expect(release()).rejects.toMatchObject({ code: "EISDIR" });
    expect(lockDirExists(p)).toBe(false);
  });

  it("takes over from ANOTHER process that died holding the lock", async () => {
    const p = paths();
    await spawnHolder(p.workDir, "crash");

    // The crash left both behind: proper-lockfile's dir (SIGKILL runs no exit
    // handler) and a sidecar naming a pid that no longer exists. Neither is
    // stale by mtime yet, so nothing but the sidecar can justify the takeover.
    expect(lockDirExists(p)).toBe(true);
    const deadPid = Number.parseInt(readFileSync(p.pidPath, "utf8"), 10);
    expect(deadPid).not.toBe(process.pid);

    await take(p);
    expect(readFileSync(p.pidPath, "utf8")).toBe(String(process.pid));
  });

  it("leaves ANOTHER process that is alive and holding the lock alone", async () => {
    const p = paths();
    await spawnHolder(p.workDir, "hold");

    await expect(acquireLock(p)).rejects.toBeInstanceOf(LockHeldError);
    // Refused without touching the live holder's lock or its sidecar.
    expect(lockDirExists(p)).toBe(true);
    expect(existsSync(p.pidPath)).toBe(true);
  });

  // The next two pin an OUTCOME, not a mechanism, and it is worth being exact
  // about what that buys. Two independent layers produce it — the sidecar
  // guards in `maybeReleaseStaleLock` and `pidIsAlive` mapping every non-ESRCH
  // result to "alive" — so removing either ALONE leaves both tests green
  // (verified by mutation). Removing BOTH turns the garbage case into a
  // takeover and the first of them fails. They are a floor under the whole
  // defence, not a pin on any one line of it: what must never happen is
  // deleting another process's lock on a sidecar we could not read.
  it("does not take over on a sidecar it cannot read as a pid", async () => {
    const p = paths();
    await spawnHolder(p.workDir, "crash");
    // Holder is genuinely dead, so ONLY the unreadable sidecar stands between
    // this and a takeover. A truncated or garbage file is not evidence of
    // death: fail closed and leave the lock for the 10s staleness to settle.
    writeFileSync(p.pidPath, "not-a-pid");

    await expect(acquireLock(p)).rejects.toBeInstanceOf(LockHeldError);
    expect(lockDirExists(p)).toBe(true);
  });

  it("does not treat pid 0 as a dead holder", async () => {
    const p = paths();
    await spawnHolder(p.workDir, "crash");
    // `process.kill(0, 0)` signals the whole process GROUP and succeeds, so a
    // `0` sidecar reads as alive either way — via the guard, or via kill(2)
    // answering about ourselves. Both are fine; taking over is not.
    writeFileSync(p.pidPath, "0");

    await expect(acquireLock(p)).rejects.toBeInstanceOf(LockHeldError);
    expect(lockDirExists(p)).toBe(true);
  });

  // End-to-end recovery through a symlinked workdir — a real configuration
  // since #28, where lock path and podman scope have to partition the host
  // identically. It does NOT discriminate `lockDirFor`'s `realpathSync`:
  // dropping that leaves this green, because the symlink is on a DIRECTORY
  // component and `<link>/run.lock.lock` resolves to the same directory the
  // canonical path names. The realpath is there to mirror proper-lockfile's own
  // derivation rather than to fix an observed break, and saying so beats a
  // comment claiming a pin that mutation does not support.
  it("recovers from a crashed holder through a symlinked workdir", async () => {
    const p = paths();
    await spawnHolder(p.workDir, "crash");

    const link = join(dir, "link");
    symlinkSync(p.workDir, link);
    await take(lockPathsFor(link));
  });
});
