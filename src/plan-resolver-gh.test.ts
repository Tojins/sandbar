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
// `origin` names a DIFFERENT repository, and the shim MODELS gh's fallback —
// it reads `remote.origin.url` when it is given no `--repo`. Delete the flag
// and the assertion sees `other/wrong`. A shim that printed a made-up sentinel
// instead would make the repo setup and every `not.toBe("other/wrong")` here
// dead weight that can never fail.
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

import { IN_CHUNK_LABEL } from "./chunks.js";
import { fetchCandidates, fetchChunkMembers } from "./plan-resolver.js";

const CONFIGURED = { owner: "acme", name: "app" };

describe("fetchCandidates names the configured repo (#34)", () => {
  let shimBin: string;
  let standingIn: string;
  let originalCwd: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
    // Reports the repository this invocation resolved, in the shape
    // `gh issue list --json number,title,body,labels` returns: the `--repo`
    // value when given one, and otherwise the `owner/name` of the working
    // directory's `origin` — which is what real gh does when the flag is
    // absent. Modelling the fallback rather than printing a sentinel is what
    // lets the assertions below be about the WRONG repo instead of about the
    // absence of a right one. `body` carries the `--label` it was asked for,
    // which is the only thing that distinguishes the two listings (#59).
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        'seen=""',
        'label=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    --repo) seen="$2"; shift 2 ;;',
        "    # Captured for #59: the two listings differ in this flag alone, and",
        "    # a wrong label returns an empty list rather than an error — the",
        "    # feature would simply be off, with nothing to notice.",
        '    --label) label="$2"; shift 2 ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        "# No --repo: resolve the repository the way gh itself does, from the",
        "# remotes of the working directory. That is what makes the",
        "# different-origin repo below load-bearing rather than decoration —",
        "# delete the flag and the assertion sees `other/wrong`, not a sentinel",
        "# this file made up.",
        "#",
        "# Parameter expansion rather than sed: the obvious `sed \"s#\\.git$##\"`",
        "# has a `$#` in it, which the shell expands to the argument count",
        "# INSIDE double quotes, so the whole expression silently matched",
        "# nothing and the fallback resolved to an empty string — a shim that",
        "# reports no repository is exactly the vacuous sentinel this replaced.",
        'if [ -z "$seen" ]; then',
        "  url=$(git config --get remote.origin.url 2>/dev/null)",
        '  if [ -z "$url" ]; then',
        '    seen="(no-remote)"',
        "  else",
        "    url=${url%.git}",
        "    repo=${url##*[:/]}",
        "    rest=${url%/*}",
        "    owner=${rest##*[:/]}",
        '    seen="$owner/$repo"',
        "  fi",
        "fi",
        'printf \'[{"number":1,"title":"%s","body":"%s","labels":[]}]\' "$seen" "$label"',
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

    // The value the shim would have resolved on its own. Drop `--repo` from
    // `fetchCandidates` and this is what comes back.
    expect(candidates[0]?.title).not.toBe("other/wrong");
    expect(candidates[0]?.title).not.toBe("(no-remote)");
  });

  // #59 — the two listings share every argument but `--label`, which is the
  // whole difference between "the queue" and "what has already landed on a
  // chunk branch". Pinned here rather than left to the union in `buildPlan`:
  // a wrong label is an empty list, not an error, so the only symptom would be
  // a feature that quietly does nothing.
  it("lists the queue on `ready-for-agent` and chunk members on `in-chunk`", async () => {
    const queue = await fetchCandidates(CONFIGURED);
    const members = await fetchChunkMembers(CONFIGURED);

    expect(queue[0]?.body).toBe("ready-for-agent");
    expect(members[0]?.body).toBe(IN_CHUNK_LABEL);
    // And the chunk-member listing names the configured repo too — it is a
    // second `gh issue list`, and #34 applies to it identically.
    expect(members[0]?.title).toBe("acme/app");
  });
});
