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

import {
  buildPlan,
  fetchCandidates,
} from "./plan-resolver.js";

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

  it("lists the queue on `ready-for-agent`", async () => {
    const queue = await fetchCandidates(CONFIGURED);

    expect(queue[0]?.body).toBe("ready-for-agent");
  });
});

// #63 — a follow-up issue filed at the top of a cycle has to be planned in that
// same cycle, or the cycle that filed it exits plan-empty with the review
// unanswered. The listing cannot deliver it (`gh issue list` is the lagging
// search backend, and nothing in the queue is younger), so the scan hands the
// issue back in. Through the shim rather than a fake, because what is being
// asserted is that the union reaches the real listing path at all.
describe("buildPlan takes candidates the listing cannot have yet (#63)", () => {
  let shimBin: string;
  let repoDir: string;
  let originalPath: string | undefined;

  const FILED = {
    number: 50,
    title: "Chunk #10: address alice's review feedback",
    body: "## Blocked by\n- #10\n",
    labels: ["ready-for-agent"],
  };

  beforeEach(async () => {
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-extra-"));
    repoDir = await mkdtemp(join(tmpdir(), "sandbar-plan-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    // An EMPTY queue and an empty chunk-member listing — the state a
    // just-filed issue is invisible in — with authoritative facts that know
    // both it and its blocker, which is how the real GraphQL batch answers.
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        '  "issue list") printf "[]" ;;',
        '  "api graphql")',
        '    printf \'{"data":{"repository":{"i50":{"state":"OPEN","labels":{"nodes":[{"name":"ready-for-agent"}]}},"i10":{"state":"CLOSED","labels":{"nodes":[]}}}}}\' ;;',
        "esac",
        "exit 0",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(shimBin, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("plans an issue the listing has not caught up with", async () => {
    const r = await buildPlan(CONFIGURED, { repoDir, extraCandidates: [FILED] });
    expect(r.plan.map((p) => p.id)).toEqual(["50"]);
  });

  it("still filters it on the authoritative facts", async () => {
    // Additive, not authoritative: an issue closed between the create and the
    // plan is dropped like any other candidate. Modelled by asking for #10,
    // which the batch above reports CLOSED.
    const closed = { ...FILED, number: 10, body: "" };
    const r = await buildPlan(CONFIGURED, { repoDir, extraCandidates: [closed] });
    expect(r.plan).toEqual([]);
  });

  it("plans nothing when nothing is handed in", async () => {
    expect((await buildPlan(CONFIGURED, { repoDir })).plan).toEqual([]);
  });
});

describe("buildPlan loads git-derived members into the candidate graph (#93)", () => {
  let shimBin: string;
  let repoDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-member-shim-"));
    repoDir = await mkdtemp(join(tmpdir(), "sandbar-member-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "sandbar@example.test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Sandbar Test"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "base"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-qb", "member"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "work"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repoDir });
    execFileSync("git", ["merge", "--no-ff", "member", "-m", "Merge sandbar/issue-60: Root"], { cwd: repoDir });
    execFileSync("git", ["update-ref", "refs/remotes/origin/sandbar/member-60", "member"], { cwd: repoDir });
    execFileSync("git", ["update-ref", "refs/remotes/origin/sandbar/chunk-60-root", "HEAD"], { cwd: repoDir });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD~1"], { cwd: repoDir });
    await writeFile(join(shimBin, "gh"), [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "issue list") printf "[]" ;;',
      '  "api graphql") printf \'{"data":{"repository":{"i60":{"number":60,"title":"Root","body":"","state":"OPEN","labels":{"nodes":[]}}}}}\' ;;',
      "esac",
    ].join("\n") + "\n", { mode: 0o755 });
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(shimBin, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("reports a member found only through origin chunk history", async () => {
    const result = await buildPlan(CONFIGURED, { repoDir, defaultLane: "review" });
    expect(result.plan).toEqual([]);
    expect(result.landedChunks[0]?.members).toEqual([{ number: 60, title: "Root" }]);
  });
});
