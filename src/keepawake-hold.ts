// The series-long wake lock, as a program (#117).
//
// `run()` holds a lock for the length of a run, and that is not long enough.
// #65's relaunch is an exit and a fresh process, so between the driver
// releasing its lock and the next one taking it there is the rest of cleanup,
// the process exit, the launcher's install check and the next run's config
// resolve — and on 2026-09-03 this repo's host slept 6 ms after a release. No
// per-run holder can cover a seam it is not alive for. The launcher can: it is
// the one process whose lifetime IS the series.
//
// So `scripts/sandbar-launch.mjs` runs THIS as a child and keeps it for the
// whole loop. A separate program rather than a call, for two reasons that are
// both about the launcher:
//
//   - THE LAUNCHER CANNOT IMPORT. It is synchronous by decision (every step is
//     `spawnSync`), it runs before the driver it would import exists, and it is
//     host-repo territory. A child process is the one seam that needs none of
//     that — one `spawn` line, and every decision about wake locks stays in
//     `keepawake.ts` where the second copy of it would otherwise have gone.
//   - THE LAUNCHER IS BLOCKED. It sits inside `spawnSync` for hours at a time,
//     so its event loop never turns and it can neither read a confirmation nor
//     notice a child dying. This program has a live loop and inherits stdout,
//     so it reports its own status on its own schedule.
//
// Its own lifetime is its stdin, matching the lock's: `resume()` + `end` means
// a launcher that exits — cleanly, or killed outright — closes the pipe, this
// exits, and the powershell child's stdin closes behind it. Nothing here can
// outlive the series and leave a machine that will not sleep.
//
// The file's EXISTENCE is also the launcher's capability probe. `sandbar.pin`
// lags this checkout always (#66), so a new launcher will run against a driver
// that predates this issue; `existsSync(dist/keepawake-hold.js)` answers "can
// this driver hold a lock for me?" without a version comparison that could
// disagree with the file it is describing.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startKeepawake } from "./keepawake.js";

export function holdUntilStdinCloses(): void {
  const lock = startKeepawake();
  lock.onStatus((line) => console.log(`sandbar launcher: ${line}`));

  const release = (): void => {
    lock.stop();
    process.exit(0);
  };

  // `end` is the launcher going away. `resume()` is required or the stream
  // stays paused and `end` never fires.
  process.stdin.resume();
  process.stdin.on("end", release);
  process.stdin.on("close", release);
  // Deliberately NOT `installCleanupTraps` (#35): that registry belongs to a
  // run, and this process owns exactly one resource. A signal here means the
  // launcher's whole process group was signalled, and the lock goes with it.
  process.on("SIGINT", release);
  process.on("SIGTERM", release);
}

// Only when this file IS the program — importing it must not take a lock. The
// realpath on both sides is `sandbar-launch.mjs`'s idiom and exists for its
// reason: node resolves symlinks before filling `import.meta.url`, and a
// mismatch here would be a silent no-op, which is the worst outcome available
// to a file whose whole job is to make a silent no-op impossible.
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(resolve(argv1)) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) holdUntilStdinCloses();
