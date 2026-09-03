// #117. One behaviour, and it is the safety property the whole design rests
// on: this program releases its lock when its stdin closes, so a launcher that
// dies — cleanly or by SIGKILL — cannot leave a host that will not sleep.
//
// The powershell child is faked here for the reason `keepawake.test.ts` gives.
// That EOF really does reach the real script, and that a SIGKILLed parent
// really does drop the powershell process, are facts about WSL interop and are
// established by running it; what is asserted here is that this file wires the
// EOF to the release at all, which is the half that can rot.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { holdUntilStdinCloses } from "./keepawake-hold.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinEnded = false;
  stdin = {
    end: () => {
      this.stdinEnded = true;
    },
  };
  kill = () => true;
  confirm() {
    this.stdout.emit("data", Buffer.from("sandbar-wake-lock-held\n"));
  }
}

class FakeStdin extends EventEmitter {
  resumed = false;
  resume() {
    this.resumed = true;
  }
}

function harness() {
  const child = new FakeChild();
  const stdin = new FakeStdin();
  const signals = new EventEmitter();
  const exits: number[] = [];
  const logged: string[] = [];
  const lock = holdUntilStdinCloses({
    isWsl2: () => true,
    spawn: (() => child) as never,
    stdin,
    signals,
    exit: (code: number) => void exits.push(code),
    log: (line: string) => void logged.push(line),
  });
  return { child, stdin, signals, exits, logged, lock };
}

describe("holdUntilStdinCloses (#117)", () => {
  it("resumes stdin, or `end` would never fire and the lock would never lift", () => {
    const h = harness();
    expect(h.stdin.resumed).toBe(true);
  });

  it("releases the lock and exits when stdin closes", () => {
    const h = harness();
    h.child.confirm();
    expect(h.lock.status()).toEqual({ kind: "held" });

    h.stdin.emit("end");
    expect(h.child.stdinEnded).toBe(true);
    expect(h.lock.status()).toEqual({ kind: "released" });
    expect(h.exits).toEqual([0]);
  });

  it("releases on a signal too — the launcher's whole group was signalled", () => {
    const h = harness();
    h.child.confirm();
    h.signals.emit("SIGTERM");
    expect(h.lock.status()).toEqual({ kind: "released" });
  });

  it("speaks with the launcher's voice, since it is the launcher's stdout", () => {
    const h = harness();
    h.child.confirm();
    expect(h.logged[0]).toBe(
      "sandbar launcher: wake-lock: held — the host will not idle-sleep while it is",
    );
  });

  it("still exits when the lock was refused — a launcher waiting on it would hang", () => {
    const child = new FakeChild();
    const stdin = new FakeStdin();
    const exits: number[] = [];
    holdUntilStdinCloses({
      isWsl2: () => false,
      spawn: (() => child) as never,
      stdin,
      signals: new EventEmitter(),
      exit: (code: number) => void exits.push(code),
      log: () => {},
    });
    stdin.emit("end");
    expect(exits).toEqual([0]);
  });
});
