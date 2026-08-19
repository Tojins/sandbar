// #34 — `gh` identifies the repository from the git remotes of the directory it
// runs in unless it is given `--repo`, so for as long as sandbar left it out,
// the planner's queue was a property of a directory: first `process.cwd()`
// (whatever shell the operator launched from), then, once #34 threaded a `cwd`,
// the object cache's `origin`. Neither is `config.ghOwner`/`config.ghRepo`.
//
// Pinned through a `gh` shim on PATH rather than a fake, so the assertion
// covers the whole chain down to `execFile` — a fake satisfies the contract no
// matter what argv the real call builds, and argv is the entire fix here.
//
// The trap this file exists to avoid: a test that runs from a directory with no
// remotes passes just as happily with `--repo` deleted, because there is
// nothing for gh to infer from. So the process stands in a REAL git repo whose
// `origin` names a DIFFERENT repository, and the shim reports what it was
// actually told. Delete the flag and the assertion sees `other/wrong`.
//
// `fetchIssueStates` is deliberately not covered: it has always named the repo,
// in its GraphQL variables. That the two now read the same `RepoRef` is the
// point of the change — `buildPlan` lists through the first and resolves state
// through the second, and a disagreement resolves one repo's issue numbers in
// another.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchCandidates } from "./plan-resolver.js";

const CONFIGURED = { owner: "acme", name: "app" };

describe("fetchCandidates names the configured repo (#34)", () => {
  let shimBin: string;
  let standingIn: string;
  let originalCwd: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
    // Reports the value gh was given for --repo, in the shape
    // `gh issue list --json number,title,body,labels` returns. Reports
    // `(inferred)` when the flag is absent — which is what gh itself would then
    // do, from the working directory's remotes.
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        'seen="(inferred)"',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in --repo) seen="$2"; shift 2 ;; *) shift ;; esac',
        "done",
        'printf \'[{"number":1,"title":"%s","body":"","labels":[]}]\' "$seen"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;

    // A real repo whose origin is NOT the configured one, so an inferred
    // answer is a wrong answer rather than no answer.
    standingIn = await mkdtemp(join(tmpdir(), "sandbar-standing-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: standingIn, stdio: "ignore" });
    };
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://github.com/other/wrong.git");
    process.chdir(standingIn);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(shimBin, { recursive: true, force: true });
    await rm(standingIn, { recursive: true, force: true });
  });

  it("passes --repo <owner>/<name> rather than letting gh infer one", async () => {
    const candidates = await fetchCandidates(CONFIGURED);

    expect(candidates[0]?.title).toBe("acme/app");
  });

  it("is unaffected by the remotes of the directory it runs in", async () => {
    const candidates = await fetchCandidates(CONFIGURED);

    expect(candidates[0]?.title).not.toBe("(inferred)");
    expect(candidates[0]?.title).not.toBe("other/wrong");
  });
});
