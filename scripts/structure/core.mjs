// The shared core of sandbar's structural checks (#183, #235): the one way a
// check asks git anything, the base it measures the branch against, and the
// lines the branch adds. Plain ESM like `scripts/stats-classify.mjs`, so a
// gate step runs it without a build; not shipped.
//
// Every git call is `git -C <dir> [--git-dir <gitDir>] -c safe.directory=*`.
// `gitDir` exists for sandbar's own gate, whose tmpfs over the clone's `.git`
// (#98) holds at most a copy from container start, so the installation
// mounts the live one read-only elsewhere: nothing here writes to the
// repository, so a read-only object store answers every question a check
// asks. `safe.directory` because the gate's container user need not own the
// clone.
//
// The base is `merge-base(HEAD, <base>)`, so a branch is measured against
// where it left the source, not where the source has since moved. A git call
// that fails, the base included, throws `StructureError`: `run.mjs` reports it
// in one line and exits 2, a red and never a skip.

import { execFileSync } from "node:child_process";

// The check could not be answered. Its message is the one line `run.mjs`
// prints.
export class StructureError extends Error {}

// `repo` is `{ dir, gitDir? }`.
export function git(repo, args) {
  const argv = [
    "-C", repo.dir,
    ...(repo.gitDir === undefined ? [] : ["--git-dir", repo.gitDir]),
    "-c", "safe.directory=*",
    ...args,
  ];
  try {
    return execFileSync("git", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // A git that ran and exited non-zero; anything else is not git's answer.
    if (typeof err.status !== "number") throw err;
    const reason = String(err.stderr).trim().split("\n")[0] || `exit ${err.status}`;
    throw new StructureError(`git ${args.join(" ")}: ${reason}`);
  }
}

export function mergeBase(repo, base) {
  return git(repo, ["merge-base", "HEAD", base]).trim();
}

// `path` parsed as JSON at `rev`.
export function readJsonAt(repo, rev, path) {
  const text = git(repo, ["show", `${rev}:${path}`]);
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new StructureError(`${path} at ${rev} is not JSON: ${err.message}`);
  }
}

// The lines `mb..HEAD` adds, per path in HEAD: added lines only, so a
// deletion-only hunk contributes nothing and a deleted file is absent.
export function addedLines(repo, mb) {
  return parseAddedLines(
    git(repo, ["diff", "-U0", "--no-prefix", "--no-color", "--no-ext-diff", `${mb}..HEAD`]),
  );
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// A `git diff -U0 --no-prefix` body to `Map<path, number[]>`, line numbers
// ascending. `--no-prefix` because `diff.noprefix` and `diff.mnemonicPrefix`
// would otherwise decide the spelling. A hunk's body is skipped by its counts,
// so a changed line that itself reads `+++ x` or `@@ …` is never taken for a
// header.
export function parseAddedLines(diff) {
  const lines = new Map();
  let path = null;
  let body = 0;
  for (const line of diff.split("\n")) {
    if (body > 0) {
      if (!line.startsWith("\\")) body--;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = line === "+++ /dev/null" ? null : line.slice(4);
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk === null) continue;
    const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const start = Number(hunk[2]);
    const added = hunk[3] === undefined ? 1 : Number(hunk[3]);
    body = removed + added;
    if (path === null || added === 0) continue;
    const into = lines.get(path) ?? [];
    for (let n = start; n < start + added; n++) into.push(n);
    lines.set(path, into);
  }
  return lines;
}
