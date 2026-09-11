// The deployment channel's one input to a running daemon (#146).
//
// A commit on main is the deploy: the box pulls it, applies it to itself, and
// builds it into the driver every installation's unit executes. What it cannot
// do is swap the code under a daemon that is mid-issue, so the converging play
// leaves a REQUEST FILE behind instead and the daemon restarts itself once it
// is safe. `deploy/ansible` owns the writing end.
//
// A FILE, not a signal: a signal would need a second trap outside cleanup.ts
// (#35 allows exactly one owner) and would be lost entirely whenever the
// request arrives while the daemon is down. A file survives that window, and
// the daemon REMOVES IT AT STARTUP — the start it was asking for has happened,
// so carrying the request into the new process would drain it straight back
// out again. Equally deliberately it is not a commit comparison per poll: the
// daemon cannot tell a driver change from a docs-only landing, and restarting
// on every landing is what that would do.
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

// `null` when no restart is pending. Anything other than "no such file" is the
// daemon failing to read a file it owns, and propagates: a request it cannot
// see is a deploy that silently never arrives.
export async function readRestartRequest(path: string): Promise<string | null> {
  try {
    return restartRequestDetail(await readFile(path, "utf8"));
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

// Returns what the cleared request carried, or `null` when none was pending.
// A removal that fails propagates for the sharper reason: a daemon that cannot
// clear the file would observe the same request on its next recompute, drain,
// exit, and be restarted into doing it again.
export async function clearRestartRequest(path: string): Promise<string | null> {
  const pending = await readRestartRequest(path);
  if (pending === null) return null;
  await rm(path);
  return pending;
}
