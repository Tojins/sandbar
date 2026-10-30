// The line-deletion map of the `missing-tests` check (#183 decision 5,
// #236): for the files Stryker cannot mutate, the literal form of "a line
// whose deletion leaves the suite green". Each changed line of a mapped file
// is deleted in a copy of the worktree, the tests mapped to it run there, and
// a green run is a finding. A blank or comment-only line is not probed:
// deleting it can change nothing.
//
// The copy is one tree under `.stryker-tmp/deletion/` (gitignored, D1),
// sharing the worktree's `node_modules`, made before any tool runs; a
// worktree it cannot copy (a file or directory it may not read) throws
// `StructureError`. The copy is walked here, not `cpSync`'d: Node's native
// `cpSync` aborts the process over a directory it may not read.
// Each probe replaces its one file and restores it. The mapped tests first
// run on the untouched copy, and a red there throws `StructureError`: no
// deletion could be judged against it. vitest's output goes to
// `.stryker-tmp/log/`.

import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { LOG_DIR, runLogged, StructureError, withFsError, WORK_DIR } from "./core.mjs";

// The first entry whose `paths` matches a file maps it; `tests` are vitest
// filters, `label` names them in a finding. An installation's files are
// config, and config needs no test: nothing under
// `deploy/ansible/installations/` is probed.
export const DELETION_MAP = [
  {
    paths: /^deploy\/(?!ansible\/installations\/).*\.(?:yml|j2|mjs)$/,
    tests: ["src/deploy-"],
    label: "src/deploy-*.test.ts",
  },
];

export function deletionEntry(path) {
  return DELETION_MAP.find((entry) => entry.paths.test(path));
}

const COMMENT_ONLY = /^\s*(?:$|#|\/\/|\/\*|\*|\{#|<!--)/;

// The lines of `lines` (1-based, into `content`) worth deleting.
export function deletableLines(content, lines) {
  const text = content.split("\n");
  return lines.filter((line) => !COMMENT_ONLY.test(text[line - 1] ?? ""));
}

const NOT_COPIED = new Set([".git", "node_modules", WORK_DIR, "coverage", ".sandbar"]);

const COPY = `${WORK_DIR}/deletion`;

// `from` copied to `to` as `cpSync` would: a symlink's copy points at
// its target's absolute path, and a FIFO or socket is left out.
function copyTree(from, to) {
  const stat = lstatSync(from);
  if (stat.isDirectory()) {
    mkdirSync(to);
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else if (stat.isSymbolicLink()) {
    symlinkSync(resolve(dirname(from), readlinkSync(from)), to);
  } else if (stat.isFile()) {
    copyFileSync(from, to);
  }
}

// `dir` copied for `runDeletions`, into its `WORK_DIR`.
export function copyWorktree(dir) {
  const copy = join(dir, COPY);
  withFsError("deletion: the worktree cannot be copied", () => {
    mkdirSync(copy);
    for (const name of readdirSync(dir).filter((entry) => !NOT_COPIED.has(entry))) {
      copyTree(join(dir, name), join(copy, name));
    }
    symlinkSync(join(dir, "node_modules"), join(copy, "node_modules"));
  });
}

// Each of `units` (`{ path, line }`, mapped paths only) deleted in turn in
// the copy of `dir` (`copyWorktree`), whose `LOG_DIR` exists; `contents`
// maps each path to its text. Resolves to the green deletions' findings and
// how many went red.
export async function runDeletions(dir, units, contents) {
  const copy = join(dir, COPY);
  const vitest = (entry, log) => runLogged(
    [process.execPath, join(copy, "node_modules", "vitest", "vitest.mjs"), "run", ...entry.tests],
    copy,
    join(dir, LOG_DIR, log),
  );
  // The copy's file is replaced, never written: a symlink's copy points into
  // the worktree, and a read-only file's copy is read-only.
  const replace = (path, text) => {
    rmSync(join(copy, path));
    writeFileSync(join(copy, path), text);
  };
  try {
    for (const entry of new Set(units.map((unit) => deletionEntry(unit.path)))) {
      const log = `deletion-baseline-${DELETION_MAP.indexOf(entry)}.log`;
      if (await vitest(entry, log) !== 0) {
        throw new StructureError(`deletion: ${entry.label} fail with no line deleted (${LOG_DIR}/${log})`);
      }
    }
    const findings = [];
    let caught = 0;
    for (const [i, { path, line }] of units.entries()) {
      const entry = deletionEntry(path);
      const content = contents.get(path);
      const lines = content.split("\n");
      replace(path, [...lines.slice(0, line - 1), ...lines.slice(line)].join("\n"));
      try {
        if (await vitest(entry, `deletion-${i}.log`) === 0) {
          findings.push(`${path}:${line}  deleted, ${entry.label} stayed green`);
        } else {
          caught++;
        }
      } finally {
        replace(path, content);
      }
    }
    return { findings, caught };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
