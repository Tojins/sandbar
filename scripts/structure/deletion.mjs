// The line-deletion map of the `tests` check (#183 decision 5, #236): for the
// files Stryker cannot mutate, the literal form of "a line whose deletion
// leaves the suite green". Each changed line of a mapped file is deleted in
// a copy of the worktree, the tests mapped to it run there, and a green run
// is a finding. A blank or comment-only line is not probed: deleting it can
// change nothing.
//
// The copy is one tree under `.stryker-tmp/deletion/` (gitignored, D1),
// sharing the worktree's `node_modules`; each probe writes its one file and
// restores it. The mapped tests first run on the untouched copy, and a red
// there throws `StructureError`: no deletion could be judged against it.
// vitest's output goes to `.stryker-tmp/log/`.

import { cpSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LOG_DIR, runLogged, StructureError, WORK_DIR } from "./core.mjs";

// The first entry whose `paths` matches a file maps it; `tests` are vitest
// filters, `label` names them in a finding.
export const DELETION_MAP = [
  {
    paths: /^deploy\/ansible\/installations\//,
    tests: ["src/deploy-", "src/structure-wiring.test.ts"],
    label: "src/deploy-*.test.ts and src/structure-wiring.test.ts",
  },
  { paths: /^deploy\/.*\.(?:yml|j2|mjs)$/, tests: ["src/deploy-"], label: "src/deploy-*.test.ts" },
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

// Each of `units` (`{ path, line }`, mapped paths only) deleted in turn in a
// copy of `dir`, whose `LOG_DIR` exists. Resolves to the green deletions'
// findings and how many went red.
export async function runDeletions(dir, units) {
  const copy = join(dir, WORK_DIR, "deletion");
  rmSync(copy, { recursive: true, force: true });
  for (const name of readdirSync(dir).filter((entry) => !NOT_COPIED.has(entry))) {
    cpSync(join(dir, name), join(copy, name), { recursive: true });
  }
  symlinkSync(join(dir, "node_modules"), join(copy, "node_modules"));
  const vitest = (entry, log) => runLogged(
    [process.execPath, join(copy, "node_modules", "vitest", "vitest.mjs"), "run", ...entry.tests],
    copy,
    join(dir, LOG_DIR, log),
  );
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
      const file = join(copy, path);
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      writeFileSync(file, [...lines.slice(0, line - 1), ...lines.slice(line)].join("\n"));
      try {
        if (await vitest(entry, `deletion-${i}.log`) === 0) {
          findings.push(`${path}:${line}  deleted, ${entry.label} stayed green`);
        } else {
          caught++;
        }
      } finally {
        writeFileSync(file, content);
      }
    }
    return { findings, caught };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
