// The deployment channel's one input to a running daemon (#146).
//
// A commit on main is the deploy: the box pulls it, applies it to itself, and
// builds it into the driver every installation's unit executes. What it cannot
// do is swap the code under a daemon that is mid-issue, so the converging play
// leaves a REQUEST FILE behind instead and the daemon restarts itself once it
// is safe. `deploy/ansible` owns the writing end, and writes a request when
// the play changed the built driver, an installation's files or units, or what
// the installation's config evaluates to as a gate stack and images (#190). The
// play detects that last case with `sandbar config-digest` after it refreshes
// the consumer clone, because a daemon fixes both at import while its sandboxes
// build from `origin/<source>`. Nothing else a consumer lands asks for one.
//
// A FILE, not a signal: a signal would need a second trap outside cleanup.ts
// (#35 allows exactly one owner) and would be lost entirely whenever the
// request arrives while the daemon is down. A file survives that window, and
// the daemon REMOVES THE REQUEST IT WAS STARTED TO ANSWER — that start has
// happened, so carrying the same request into the new process would drain it
// straight back out again. Which request that is has to be decided by CONTENT
// rather than by "whatever is there once startup finishes": a process is pinned
// to one build at `execve` (node realpaths its entry, so a later flip of
// `/opt/sandbar/current` cannot reach it), while the converging play runs every
// five minutes and may write a request for the NEXT commit at any point during
// a startup that spends minutes in preflight and image builds. Deleting that
// one would leave the box running a driver nothing asked for — the revert case
// included. So the daemon reads the pending request before it does anything
// slow and removes only that exact content, leaving anything written later for
// the first recompute to latch. Equally deliberately it is not a commit
// comparison per poll: the daemon cannot tell a driver change from a docs-only
// landing, and restarting on every landing is what that would do.
//
// Beside the config file, because that directory IS the installation: the play
// places `sandbar.config.mjs` and this file together, and deriving the path
// from the config the daemon was actually started with leaves no second
// statement of where the installation lives to disagree with the play. A
// programmatic `run(config)` with no config file has no installation directory
// and therefore no channel; `run-start`'s `configPath: null` is that fact in
// the record already.
//
// The content is the commit the play applied, and it is EVIDENCE only: what
// the daemon decides is "restart", never which commit to run. The driver it
// relaunches into is whatever `/opt/sandbar/current` points at by then, which
// is the same question `run-start`'s driver identity answers for real.
//
// A second line reading `urgent` is the one other thing the file can say: the
// play writes it when a commit it applied carries the `Sandbar-Restart: now`
// trailer, and keeps it while an earlier urgent request is still pending. An
// ordinary request is deferred while the pool keeps working (`restartDeferMs`,
// `restartDueReason` in scheduler.ts) so landings share one drain; an urgent
// one — a revert, a fix to the loop itself — drains at once.

import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isErrno } from "./errors.js";

export const RESTART_REQUEST_FILE = "restart-requested";

export function restartRequestPath(configPath: string): string {
  return join(dirname(configPath), RESTART_REQUEST_FILE);
}

// What the event record says about one request. The play writes a commit, but
// a request with nothing readable in it is still a request: the file's
// EXISTENCE is the instruction and this line only has to name what it carried.
export function restartRequestDetail(contents: string): string {
  const first = contents.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first === "" ? "no commit recorded" : first;
}

export type RestartRequest = {
  readonly detail: string;
  readonly urgent: boolean;
};

export function parseRestartRequest(contents: string): RestartRequest {
  return {
    detail: restartRequestDetail(contents),
    urgent: contents.split(/\r?\n/).slice(1).some((line) => line.trim() === "urgent"),
  };
}

// `null` when no restart is pending. Anything other than "no such file" is the
// daemon failing to read a file it owns, and propagates: a request it cannot
// see is a deploy that silently never arrives.
export async function readRestartRequest(path: string): Promise<RestartRequest | null> {
  try {
    return parseRestartRequest(await readFile(path, "utf8"));
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

// Removes the request only while it still names `answered` — the commit the
// caller read before it became the process that answers it. A file withdrawn or
// rewritten for a newer commit since then is left exactly where it is and
// `false` says so; the ordinary per-recompute read is what picks that one up.
// A removal that fails propagates for the sharper reason: a daemon that cannot
// clear the file would observe the same request on its next recompute, drain,
// exit, and be restarted into doing it again. `run.ts` halts the startup on it
// through the same path as every other post-lock startup fault, so the refusal
// is an event and cleanup still releases what this process holds.
export async function clearRestartRequest(
  path: string,
  answered: string,
): Promise<boolean> {
  if ((await readRestartRequest(path))?.detail !== answered) return false;
  await rm(path);
  return true;
}
