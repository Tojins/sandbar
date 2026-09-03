// #117. What is asserted here is the three properties `keepawake.ts`'s header
// claims, because each of them is a thing the old module got wrong silently:
// the lock is CONFIRMED by the OS rather than by a successful spawn, every
// refusal has a REASON in it, and a lock that dies mid-run is noticed.
//
// The powershell child is faked. What it would prove — that
// SetThreadExecutionState is honoured, that closing stdin releases in ~14 ms,
// that SIGKILLing the parent takes the lock with it — is a fact about Windows
// and WSL interop, not about this module, and it was established by running it
// against the real host (the header records the numbers). Faking it here buys
// the cases the real one cannot be made to produce on demand: a child that
// exits before confirming, a child that dies four hours in, a spawn that
// throws.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { startKeepawake, type WakeLockIo } from "./keepawake.js";

// Enough of a ChildProcess for this module: two readable streams to push at, a
// writable stdin whose `end` is recorded, and the exit/error events.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinEnded = false;
  killed: string | null = null;
  stdin = {
    end: () => {
      this.stdinEnded = true;
    },
  };
  kill = (signal: string) => {
    this.killed = signal;
    return true;
  };
  confirm(marker = "sandbar-wake-lock-held\n") {
    this.stdout.emit("data", Buffer.from(marker));
  }
  die(code: number | null, signal: string | null = null) {
    this.emit("exit", code, signal);
  }
}

// `spawn` is a heavily-overloaded node type and this module uses one shape of
// it; the cast is at the seam rather than inside the module, so production
// keeps the real signature.
function ioWith(children: FakeChild[]): WakeLockIo {
  let n = 0;
  return {
    isWsl2: () => true,
    spawn: ((): FakeChild => {
      const c = children[n];
      n += 1;
      if (!c) throw new Error(`unexpected spawn #${n}`);
      return c;
    }) as never,
  };
}

function linesOf(lock: ReturnType<typeof startKeepawake>): string[] {
  const seen: string[] = [];
  lock.onStatus((line) => seen.push(line));
  return seen;
}

describe("startKeepawake — the lock is confirmed, not assumed", () => {
  it("is not held until the OS has confirmed it, however well the spawn went", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    // The spawn succeeded. That is the fact the old module reported by saying
    // nothing, and it is not the fact anyone wants.
    expect(lock.status()).toBeNull();

    child.confirm();
    expect(lock.status()).toEqual({ kind: "held" });
    expect(linesOf(lock)).toEqual([
      "wake-lock: held — the host will not idle-sleep while it is",
    ]);
  });

  it("reads the marker out of accumulated stdout, not out of one chunk", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.stdout.emit("data", Buffer.from("﻿sandbar-wake"));
    expect(lock.status()).toBeNull();
    child.stdout.emit("data", Buffer.from("-lock-held\r\n"));
    expect(lock.status()).toEqual({ kind: "held" });
  });

  it("names the reason when the host is not WSL2, and spawns nothing", () => {
    const lock = startKeepawake({ isWsl2: () => false, spawn: (() => {
      throw new Error("must not spawn");
    }) as never });
    expect(lock.status()).toEqual({
      kind: "refused",
      reason: "not WSL2 — the host OS owns power management here",
    });
    expect(linesOf(lock)[0]).toContain("NOT held");
  });

  it("reports a spawn that throws as a refusal carrying the cause", () => {
    const lock = startKeepawake({
      isWsl2: () => true,
      spawn: (() => {
        throw new Error("spawn powershell.exe ENOENT");
      }) as never,
    });
    expect(lock.status()).toMatchObject({ kind: "refused" });
    expect(linesOf(lock)[0]).toContain("ENOENT");
  });

  it("reports an exit before the marker as a refusal, with the exit and stderr", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.stderr.emit(
      "data",
      Buffer.from("Exception calling SetThreadExecutionState\n  at line 1\n"),
    );
    child.die(1);
    // A refusal, not a loss: the flag was never set, so nothing was given up.
    expect(lock.status()).toMatchObject({ kind: "refused" });
    const line = linesOf(lock)[0] ?? "";
    expect(line).toContain("exit 1");
    expect(line).toContain("SetThreadExecutionState");
    // Collapsed to one line — this goes inside a single log entry.
    expect(line).not.toContain("\n");
  });

  it("reports an ASYNC spawn failure — the realistic one — as a refusal", () => {
    // A WSL2 host without interop on PATH fails here, not in the synchronous
    // throw above: node reports ENOENT by event, after the spawn returned.
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.emit("error", new Error("spawn powershell.exe ENOENT"));
    expect(lock.status()).toMatchObject({ kind: "refused" });
    expect(linesOf(lock)[0]).toContain("ENOENT");
  });

  it("keeps a late error off a lock that is already held", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.confirm();
    child.emit("error", new Error("EPIPE"));
    expect(lock.status()).toEqual({ kind: "held" });
  });

  it("bounds the stderr it quotes, because this goes inside one log line", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.stderr.emit("data", Buffer.from("x".repeat(1000)));
    child.die(1);
    const line = linesOf(lock)[0] ?? "";
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(400);
  });

  it("names the signal when the child was killed rather than exited", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.die(null, "SIGKILL");
    expect(linesOf(lock)[0]).toContain("killed by SIGKILL");
  });
});

describe("startKeepawake — a lock that dies is noticed and retaken", () => {
  it("reports the loss and takes a new one", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const lock = startKeepawake(ioWith([first, second]));
    first.confirm();
    expect(lock.status()).toEqual({ kind: "held" });

    // Four hours in, the powershell process goes away. Before #117 this was
    // four more hours with no lock and nothing in any record to say so.
    first.die(0);
    expect(lock.status()).toMatchObject({ kind: "lost", retaking: true });

    second.confirm();
    expect(lock.status()).toEqual({ kind: "held" });
    expect(linesOf(lock).map((l) => l.split(" —")[0])).toEqual([
      "wake-lock: held",
      "wake-lock: LOST",
      "wake-lock: held",
    ]);
  });

  it("gives up rather than becoming a spawn loop", () => {
    // Six children: the first plus exactly MAX_RETAKES. A seventh spawn is the
    // failure this bound exists to stop — `ioWith` throws on it, and `take`
    // catches that into a `refused`, so what actually pins the bound is the
    // FINAL status being a give-up rather than another attempt.
    const kids = Array.from({ length: 6 }, () => new FakeChild());
    const lock = startKeepawake(ioWith(kids));
    for (const kid of kids) {
      kid.confirm();
      kid.die(0);
    }
    expect(lock.status()).toMatchObject({ kind: "lost", retaking: false });
    expect(linesOf(lock).at(-1)).toContain("giving up");
  });
});

describe("startKeepawake — release", () => {
  it("closes stdin, which is what the lock's lifetime actually is", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.confirm();
    lock.stop();
    expect(child.stdinEnded).toBe(true);
    expect(child.killed).toBe("SIGTERM");
    expect(lock.status()).toEqual({ kind: "released" });
  });

  it("says nothing about releasing a lock it never held", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    lock.stop();
    // A `released` line after a refusal reads as a lock that had been held.
    expect(linesOf(lock)).not.toContain("wake-lock: released");
  });

  it("cannot leave an orphan when it races a retake", () => {
    // `take()` assigns `child` with no await between the spawn and the
    // assignment, and the exit handler returns early once `stopping` is set —
    // so the child a retake was about to install is the one `stop()` holds.
    const first = new FakeChild();
    const second = new FakeChild();
    const lock = startKeepawake(ioWith([first, second]));
    first.confirm();
    first.die(0);
    second.confirm();
    lock.stop();
    expect(second.stdinEnded).toBe(true);
    expect(second.killed).toBe("SIGTERM");
  });

  it("is idempotent, and a child dying after it is not a loss", () => {
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    child.confirm();
    lock.stop();
    lock.stop();
    child.die(null, "SIGTERM");
    expect(linesOf(lock).filter((l) => l.includes("released"))).toHaveLength(1);
    expect(linesOf(lock).some((l) => l.includes("LOST"))).toBe(false);
  });
});

describe("startKeepawake — reporting", () => {
  it("does not unhook a sink when a second one is added", () => {
    // `run.ts` reports to the log and to stdout; a subscribe-shaped call that
    // silently dropped the first subscriber would be this module's own
    // complaint — failing by saying nothing — with a new name.
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child]));
    const first: string[] = [];
    const second: string[] = [];
    lock.onStatus((l) => first.push(l));
    lock.onStatus((l) => second.push(l));
    child.confirm();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });


  it("replays what happened before a sink was attached", () => {
    // The case `run.ts` is in: the lock is taken above #70's boundary, so the
    // log tree it reports into does not exist yet.
    const child = new FakeChild();
    const lock = startKeepawake(ioWith([child, new FakeChild()]));
    child.confirm();
    child.die(0);

    const seen: string[] = [];
    lock.onStatus((line) => seen.push(line));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("held");
    expect(seen[1]).toContain("LOST");
  });
});
