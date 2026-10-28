// The `version` check (#183 decision 4, #235): the branch as a whole moves
// `version` above its base. `package.json`'s `version` at HEAD must be
// strictly above its value at `merge-base(HEAD, <base>)`, and both of
// `package-lock.json`'s copies at HEAD (`version` and `packages[""].version`)
// must equal it.
//
// The branch, not each commit: a commit without a bump cannot be repaired by
// a later one without rewriting history, and a bump inside a branch carries
// nothing anyway, because the merger rewrites the value on landing
// (`version-conflict.ts`). In the landing shape (HEAD a merge onto
// `origin/main`) the merge base is `origin/main` itself, so the check asks
// whether the merged value is above the source's.
//
// Both sides are read from commits, never from the worktree: the verdict is
// about what was committed (D1).

import { mergeBase, readJsonAt } from "./core.mjs";

// `X.Y.Z` as `package.json` writes it, or null. The driver's own parser
// (`src/requires-sandbar.ts`) is TypeScript behind a build, which a gate step
// that runs before `npm test` cannot rely on.
export function parseVersion(raw) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(raw));
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isAbove(head, base) {
  const i = head.findIndex((part, j) => part !== base[j]);
  return i !== -1 && head[i] > base[i];
}

// What is wrong with `head` (package.json at HEAD) against `base`
// (package.json at the merge base, read from `baseRef`) and `lock`
// (package-lock.json at HEAD), one line each; empty when nothing is.
export function versionFindings(baseRef, base, head, lock) {
  const findings = [];
  const headVersion = parseVersion(head.version);
  const baseVersion = parseVersion(base.version);
  if (headVersion === null) {
    findings.push(`package.json: version ${head.version} is not X.Y.Z`);
  } else if (baseVersion === null) {
    findings.push(`package.json: ${baseRef}'s version ${base.version} is not X.Y.Z`);
  } else if (!isAbove(headVersion, baseVersion)) {
    findings.push(`package.json: version ${head.version} is not above ${baseRef}'s ${base.version}`);
  }
  const mirrors = [["version", lock.version], ['packages[""].version', lock.packages?.[""]?.version]];
  for (const [field, value] of mirrors) {
    if (value !== head.version) {
      findings.push(`package-lock.json: ${field} ${value} is not package.json's ${head.version}`);
    }
  }
  return findings;
}

export function checkVersion(repo, baseRef) {
  const base = readJsonAt(repo, mergeBase(repo, baseRef), "package.json");
  const head = readJsonAt(repo, "HEAD", "package.json");
  const lock = readJsonAt(repo, "HEAD", "package-lock.json");
  return {
    findings: versionFindings(baseRef, base, head, lock),
    summary: `version: ${head.version} is above ${baseRef}'s ${base.version}, and package-lock.json agrees`,
  };
}
