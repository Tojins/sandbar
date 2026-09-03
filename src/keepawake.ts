// WSL2 wake lock (#117).
//
// Linux on its own does not need this — the host OS controls power. On WSL2 the
// *Windows* host puts the machine to sleep, suspending WSL with it. We hold a
// powershell.exe child that calls SetThreadExecutionState with
// ES_CONTINUOUS | ES_SYSTEM_REQUIRED for as long as it is alive.
//
// THE HOST SLEEPS THE MOMENT SANDBAR LETS GO. Every sleep on this repo's own
// host on 2026-09-03 began within minutes of a run ending, and one of them
// began 6 ms after the `exit: relaunch` line — `Kernel-Power` reason
// `System Idle` each time, which is what says the request was not held: Windows
// does not idle-sleep through a live ES_SYSTEM_REQUIRED. The day before, four
// back-to-back runs covering fourteen hours recorded no sleep at all. The
// request works; the failure was entirely in WHEN it is held. So three
// properties, and each of them is a decision:
//
//   - IT IS CONFIRMED, NOT ASSUMED. The script prints `HELD_MARKER` only after
//     SetThreadExecutionState has returned a non-zero previous state, and only
//     that line promotes the lock to `held`. A successful `spawn` proves
//     powershell.exe started, which is not the same fact and was the one the
//     old code reported by saying nothing. Everything else — not WSL2, a spawn
//     error, an exit before the marker — is a REFUSAL with a reason, and #70
//     wants refusals in the log as much as outcomes.
//   - IT IS RELEASED BY EOF ON STDIN, not by a kill. The script blocks on
//     `[Console]::In.ReadToEnd()`, so the lock's lifetime is the lifetime of
//     the pipe: closing stdin releases it in ~14 ms, and the parent DYING
//     releases it too — verified by SIGKILLing the parent and watching the
//     powershell process count drop. A wake lock that can outlive its owner is
//     a machine that never sleeps again until somebody reboots, and that is a
//     worse failure than the one this module exists to fix. `stop()` closes the
//     pipe and kills as a belt; process death alone is enough.
//   - IT IS SUPERVISED. A child that dies mid-run is four more hours with no
//     lock and, before this, no way to find out: the module logged nothing at
//     all, and answering "was the lock held during run X?" meant reproducing
//     the powershell call by hand. An unexpected exit is reported and retaken,
//     up to MAX_RETAKES so a permanently broken spawn cannot become a spawn
//     loop.
//
// WHAT THIS MODULE DOES NOT DECIDE is when the lock is dropped around a
// relaunch. #65's exit-75 seam is between two processes, so no per-run holder
// can span it; `scripts/sandbar-launch.mjs` holds one of these for the whole
// series by running `keepawake-hold.js`, and `run.ts` holds its own for the
// run. Two overlapping requests are exactly one request to Windows, which ORs
// them and drops the state when the last one goes — so the two need no
// handshake, and inventing one would couple the launcher (which must work
// before the driver it would import exists) to this module's internals to buy
// nothing.
//
// Not a `powercfg` call and not a scheduled task: both change the HOST's
// configuration, and sandbar asks Windows not to sleep, it does not reconfigure
// the machine. The request dies with the process that made it, which is the
// property that makes it safe to make at all.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

// The line the script prints once, after the API call has succeeded. Read as a
// substring of accumulated stdout rather than as an exact line: powershell may
// emit it with a BOM or split across two reads, and a marker that has to arrive
// intact in one chunk is a lock that reports itself refused at random.
const HELD_MARKER = "sandbar-wake-lock-held";

// PowerShell parses 0x80000001 as Int32 (= -2147483647), and
// SetThreadExecutionState's uint32 parameter rejects the negative value with a
// non-terminating MethodException — the script then blocks forever without ever
// setting the flag. Use decimals so PowerShell widens to Int64 before the API
// call, and force terminating errors so a future signature mismatch reaches
// stderr instead of vanishing.
//
// The return value is the PREVIOUS execution state, and NULL (0) on failure.
// That is the only evidence available that the OS honoured the request, so the
// script throws on it and the marker is printed strictly after.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop';
$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';
$api = Add-Type -MemberDefinition $sig -Name 'PSAPICall' -Namespace 'WinAPI' -PassThru;
$ES_CONTINUOUS = 2147483648;
$ES_SYSTEM_REQUIRED = 1;
if ($api::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) -eq 0) {
  throw 'SetThreadExecutionState returned NULL: the request was not honoured.';
}
Write-Output '${HELD_MARKER}';
[void][Console]::In.ReadToEnd();
`;

// A spawn that keeps failing must not become a spawn loop. Five is enough to
// ride out a transient — a powershell.exe killed by something on the Windows
// side, an interop hiccup — and small enough that a broken host says so and
// stops instead of filling the log for four hours.
const MAX_RETAKES = 5;

// stderr is an operator-facing detail inside a one-line log entry, so it is
// bounded here rather than at the point of rendering. A PowerShell stack trace
// is a dozen lines; the first of them names the fault.
const MAX_DETAIL_CHARS = 300;

export type WakeLockStatus =
  | { kind: "held" }
  | { kind: "refused"; reason: string }
  | { kind: "lost"; reason: string; retaking: boolean }
  | { kind: "released" };

export interface WakeLock {
  // Releases the lock. Idempotent; safe to call before the child has confirmed
  // anything, and safe to call when the lock was never taken.
  stop(): void;
  // Every status this lock has reported, and every one it reports later. The
  // replay is the point: `run.ts` takes the lock before the log tree exists
  // (#70 wants it covering preflight and the image builds too), so the sink
  // arrives after the first status and would otherwise miss it.
  onStatus(sink: (line: string) => void): void;
  // For tests and for `keepawake-hold.ts`, which has to keep a process alive
  // exactly as long as the lock is worth holding.
  readonly status: () => WakeLockStatus | null;
}

export interface WakeLockIo {
  spawn?: typeof spawn;
  isWsl2?: () => boolean;
}

// One spelling of every line this module puts in a log or on a terminal.
export function formatWakeLockStatus(status: WakeLockStatus): string {
  switch (status.kind) {
    case "held":
      return "wake-lock: held — the host will not idle-sleep while it is";
    case "refused":
      return `wake-lock: NOT held — ${status.reason}`;
    case "lost":
      return `wake-lock: LOST — ${status.reason}${
        status.retaking ? "; retaking" : "; giving up"
      }`;
    case "released":
      return "wake-lock: released";
  }
}

function detailOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…`
    : trimmed;
}

function defaultIsWsl2(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function startKeepawake(io: WakeLockIo = {}): WakeLock {
  const spawnFn = io.spawn ?? spawn;
  const isWsl2 = io.isWsl2 ?? defaultIsWsl2;

  const lines: string[] = [];
  let sink: ((line: string) => void) | null = null;
  let current: WakeLockStatus | null = null;
  let child: ChildProcess | null = null;
  let stopping = false;
  let retakes = 0;

  const report = (status: WakeLockStatus): void => {
    current = status;
    const line = formatWakeLockStatus(status);
    lines.push(line);
    sink?.(line);
  };

  const take = (): void => {
    let held = false;
    let out = "";
    let err = "";
    let started: ChildProcess;
    try {
      started = spawnFn("powershell.exe", ["-NoProfile", "-Command", PS_SCRIPT], {
        // stdin is the lock's lifeline and stderr is the only place a failed
        // API call can say so. The old code passed "ignore" for all three,
        // which threw away the very noise `$ErrorActionPreference = 'Stop'`
        // was set to produce.
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      report({
        kind: "refused",
        reason: `powershell.exe could not be started (${
          e instanceof Error ? e.message : String(e)
        })`,
      });
      return;
    }
    child = started;

    started.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk);
      if (!held && out.includes(HELD_MARKER)) {
        held = true;
        report({ kind: "held" });
      }
    });
    started.stderr?.on("data", (chunk: Buffer | string) => {
      err += String(chunk);
    });
    started.on("error", (e: Error) => {
      if (stopping || held) return;
      report({
        kind: "refused",
        reason: `powershell.exe could not be started (${e.message})`,
      });
    });
    started.on("exit", (code: number | null, signal: string | null) => {
      if (stopping) return;
      const how =
        code === null ? `killed by ${signal ?? "a signal"}` : `exit ${code}`;
      const detail = detailOf(err);
      const because = detail === "" ? how : `${how}: ${detail}`;
      if (!held) {
        // Never confirmed, so this is a refusal rather than a loss: the flag
        // was never set and nothing has been given up.
        report({
          kind: "refused",
          reason: `powershell.exe ended before confirming the request (${because})`,
        });
        return;
      }
      const retaking = retakes < MAX_RETAKES;
      report({ kind: "lost", reason: because, retaking });
      if (retaking) {
        retakes += 1;
        take();
      }
    });
  };

  if (!isWsl2()) {
    // Not a failure. On a real Linux host the OS this process runs on is the
    // one that decides about sleep, and it is not sleeping under an active
    // workload; saying so once is what keeps "no wake-lock line" from being
    // ambiguous between "not needed" and "not implemented".
    report({
      kind: "refused",
      reason: "not WSL2 — the host OS owns power management here",
    });
  } else {
    take();
  }

  return {
    stop(): void {
      if (stopping) return;
      stopping = true;
      const c = child;
      const wasHeld = current?.kind === "held";
      child = null;
      if (!c) return;
      try {
        // EOF is what the script waits for; the kill is a belt for a child
        // that is wedged somewhere before the read.
        c.stdin?.end();
        c.kill("SIGTERM");
      } catch {
        // A child that has already gone is the outcome this asks for.
      }
      // Only what was taken can be released. A `released` line after a refusal
      // would read as a lock that had been held, which is the ambiguity this
      // module exists to remove.
      if (wasHeld) report({ kind: "released" });
    },
    onStatus(next: (line: string) => void): void {
      sink = next;
      for (const line of lines) next(line);
    },
    status: () => current,
  };
}
