// #34 — the argv of the `gh` calls that WRITE to the tracker.
//
// `finalize.ts`, `merger.ts` and `chunk-reconcile.ts` are adapter-driven, and
// every test that drives them uses a fake. That is the blind spot CLAUDE.md
// names explicitly: a fake satisfies the contract no matter what argv the real
// adapter builds. These are the calls that post a human's handoff comment, flip
// the queue label, open a review surface and CLOSE the issue — so "which
// repository" being wrong here is not a degraded prompt, it is a comment nobody
// reads and an issue closed in the wrong place.
//
// One suite at the bottom uses the same shim the other way round — to make
// `gh` FAIL, or answer something unparseable — because the reads that decide
// which chunks are acted on (#64) promise to fail soft, and no fake adapter
// sits low enough to break that promise.
//
// Asserted through a `gh` shim on PATH that records its own argv, driving the
// REAL adapters. The shim resolves nothing from the working directory: the
// point is only that `--repo <owner>/<name>` is present and correct, which is
// what a fake cannot see.
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkForgeWrites } from "./chunk-land.js";
import {
  fetchLandRequestPullRequests,
  fetchPullRequestsForBranches,
} from "./chunk-reconcile.js";
import { realAdapter as realFinalizeAdapter } from "./finalize.js";
import { realAdapter as realMergerAdapter } from "./merger.js";
import { repoLayout } from "./repo-cache.js";

const REPO = { owner: "acme", name: "app" };

describe("the tracker WRITE calls name the repository (#34)", () => {
  let shimBin: string;
  let argvLog: string;
  let originalPath: string | undefined;
  const beforeOriginWrite = async (): Promise<void> => {
    await appendFile(argvLog, '["lease"]\n');
  };

  // Every recorded invocation, as argv arrays.
  const records = async (): Promise<string[][]> => {
    const raw = await readFile(argvLog, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string[]);
  };
  const calls = async (): Promise<string[][]> =>
    (await records()).filter((argv) => argv[0] !== "lease");

  const repoFlagOf = (argv: readonly string[]): string | undefined => {
    const i = argv.indexOf("--repo");
    return i < 0 ? undefined : argv[i + 1];
  };

  beforeEach(async () => {
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-ghargv-"));
    argvLog = join(shimBin, "argv.jsonl");
    await writeFile(argvLog, "");
    // Appends its argv as a JSON array, then answers. `issue view --json state`
    // is the one call whose stdout is parsed, so it gets a body.
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        `log='${argvLog}'`,
        'printf "[" >> "$log"',
        'sep=""',
        'for a in "$@"; do',
        '  printf \'%s"%s"\' "$sep" "$a" >> "$log"',
        '  sep=","',
        "done",
        'printf "]\\n" >> "$log"',
        'case "$*" in',
        '  "pr list"*) printf "[]" ;;',
        '  *--json*state*) printf \'{"state":"OPEN"}\' ;;',
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
  });

  describe("finalize", () => {
    const adapter = () =>
      realFinalizeAdapter({
        layout: repoLayout("/nonexistent-host-cwd", ".sandbar"),
        repo: REPO,
        sourceBranch: "main",
        beforeOriginWrite,
      });

    it("posts the handoff comment to the configured repo", async () => {
      await adapter().postComment(42, "handoff body");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "comment", "42"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("handoff body");
    });

    it("checks repository ownership before tracker writes", async () => {
      const beforeOriginWrite = vi.fn(async () => undefined);
      const guarded = realFinalizeAdapter({
        layout: repoLayout("/nonexistent-host-cwd", ".sandbar"),
        repo: REPO,
        sourceBranch: "main",
        beforeOriginWrite,
      });

      await guarded.postComment(42, "handoff body");
      await guarded.editLabels(42, ["ready-for-agent"], ["agent-stuck"]);
      expect(beforeOriginWrite).toHaveBeenCalledTimes(3);
    });

    it("does not classify a rejected ownership barrier as a label failure", async () => {
      const lost = new Error("origin lease lost");
      const guarded = realFinalizeAdapter({
        layout: repoLayout("/nonexistent-host-cwd", ".sandbar"),
        repo: REPO,
        sourceBranch: "main",
        beforeOriginWrite: async () => { throw lost; },
      });

      await expect(guarded.editLabels(42, ["ready-for-agent"], []))
        .rejects.toBe(lost);
      expect(await calls()).toEqual([]);
    });

    // Two separate `gh issue edit` calls, remove first (#8). BOTH must carry
    // the flag — a labelled-in-one-repo, de-queued-in-another split would
    // re-pick the issue forever.
    it("names the repo on both halves of the label flip", async () => {
      await adapter().editLabels(42, ["ready-for-agent"], ["agent-stuck"]);

      const recorded = await calls();
      expect(recorded).toHaveLength(2);
      for (const argv of recorded) {
        expect(argv.slice(0, 3)).toEqual(["issue", "edit", "42"]);
        expect(repoFlagOf(argv)).toBe("acme/app");
      }
      expect(recorded[0]).toContain("--remove-label");
      expect(recorded[1]).toContain("--add-label");
    });

    it("reads the issue's state from the configured repo", async () => {
      const state = await adapter().issueState(42);

      expect(state).toBe("OPEN");
      const [argv] = await calls();
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("--json");
    });
  });

  describe("merger", () => {
    // Only the gh calls are exercised; the cast covers the git/podman deps
    // these three never reach, exactly as merger-git.test.ts does.
    const adapter = () =>
      realMergerAdapter({
        cwd: "/nonexistent-merger-worktree",
        repo: REPO,
        sourceBranch: "main",
        beforeOriginWrite,
      } as unknown as Parameters<typeof realMergerAdapter>[0]);

    it("comments the abandon/revert reason on the configured repo", async () => {
      await adapter().commentOnIssue(7, "reverted because…");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "comment", "7"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
    });

    it("checks repository ownership before merger and chunk-wrapup writes", async () => {
      const beforeOriginWrite = vi.fn(async () => undefined);
      const guarded = realMergerAdapter({
        cwd: "/nonexistent-merger-worktree",
        repo: REPO,
        sourceBranch: "main",
        beforeOriginWrite,
      } as unknown as Parameters<typeof realMergerAdapter>[0]);

      await guarded.commentOnIssue(7, "reverted because…");
      await guarded.closeIssue(7, "landed");
      expect(beforeOriginWrite).toHaveBeenCalledTimes(2);
    });

    it("does not classify a rejected ownership barrier as a merger write failure", async () => {
      const lost = new Error("origin lease lost");
      const guarded = realMergerAdapter({
        cwd: "/nonexistent-merger-worktree",
        repo: REPO,
        sourceBranch: "main",
        beforeOriginWrite: async () => { throw lost; },
      } as unknown as Parameters<typeof realMergerAdapter>[0]);

      await expect(guarded.commentOnIssue(7, "never posted")).rejects.toBe(lost);
      expect(await calls()).toEqual([]);
    });

    // #62 — the chunk PR is a WRITE too, and the wrong repo here is a review
    // surface opened where nobody is looking while the branch grows elsewhere.
    it("opens the chunk PR as a draft, in the configured repo, against the source branch", async () => {
      // A real cwd, unlike the ones above: this call runs `gh` FROM the merger
      // worktree (as forge-verify's PR calls do), so a directory that does not
      // exist fails the spawn before any argv is recorded.
      await realMergerAdapter({
        cwd: shimBin,
        repo: REPO,
        sourceBranch: "main",
        beforeOriginWrite,
      } as unknown as Parameters<typeof realMergerAdapter>[0]).ensureChunkPullRequest({
        chunkBranch: "sandbar/chunk-42-c",
        title: "Sandbar chunk #42: x",
        body: "members",
      });

      const [list, create] = await calls();
      expect(list?.slice(0, 2)).toEqual(["pr", "list"]);
      expect(repoFlagOf(list ?? [])).toBe("acme/app");
      expect(create?.slice(0, 2)).toEqual(["pr", "create"]);
      expect(repoFlagOf(create ?? [])).toBe("acme/app");
      expect(create).toContain("--draft");
      const head = (create ?? []).indexOf("--head");
      expect(create?.[head + 1]).toBe("sandbar/chunk-42-c");
      const base = (create ?? []).indexOf("--base");
      expect(create?.[base + 1]).toBe("main");
    });
  });

  // #64 — the wrap-up's writes, which the merge phase and the plan-time
  // reconciler share one implementation of (`chunkForgeWrites`). Driven through
  // BOTH real adapters rather than through the factory directly: what the
  // factory builds is already one spelling, and what could still drift is
  // whether each adapter is actually wired to it. Nothing here is a whole
  // second surface — that is the point of there being one.
  describe.each([
    [
      "merger",
      () =>
        realMergerAdapter({
          cwd: "/nonexistent-merger-worktree",
          repo: REPO,
          sourceBranch: "main",
          beforeOriginWrite,
        } as unknown as Parameters<typeof realMergerAdapter>[0]),
    ],
    [
      // Built exactly as `reconcileLandedChunks` builds it — the reconciler has
      // no adapter of its own to name, only these three arguments.
      "reconciler",
      () =>
        chunkForgeWrites({
          repo: REPO,
          gitCwd: "/nonexistent-bare-cache",
          errPrefix: "reconcile",
          beforeOriginWrite,
        }),
    ],
  ])("the chunk wrap-up's writes, via the %s adapter", (_name, adapter) => {
    // The sharpest of them: closing an issue in the wrong repository is the one
    // write that is not merely noise to whoever receives it.
    it("closes a member in the configured repo, with its comment", async () => {
      await adapter().closeIssue(7, "the chunk landed on main");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "close", "7"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("the chunk landed on main");
      expect(await records()).toEqual([["lease"], argv]);
    });

    // The same call the auto lane drops `ready-for-agent` with, which is why it
    // is not spelled twice either.
    it("drops a label in the configured repo", async () => {
      await adapter().removeLabel(7, "needs-review");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "edit", "7"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("--remove-label");
      expect(argv).toContain("needs-review");
      expect(await records()).toEqual([["lease"], argv]);
    });

    // `land` is the chunk's queue, so the wrong repository here is a request
    // that is honoured again next cycle — a whole merger worktree and gate
    // stack spent to discover the branch it names is gone.
    it("drops the land label in the configured repo", async () => {
      await adapter().removePullRequestLabel(9, "land");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["pr", "edit", "9"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("--remove-label");
      expect(argv).toContain("land");
      expect(await records()).toEqual([["lease"], argv]);
    });

    it("comments on and closes the chunk pull request in the configured repo", async () => {
      await adapter().commentOnPullRequest(9, "landed");
      await adapter().closePullRequest(9);

      const [comment, close] = await calls();
      expect(comment?.slice(0, 3)).toEqual(["pr", "comment", "9"]);
      expect(repoFlagOf(comment ?? [])).toBe("acme/app");
      expect(close?.slice(0, 3)).toEqual(["pr", "close", "9"]);
      expect(repoFlagOf(close ?? [])).toBe("acme/app");
      // The branch delete is the wrap-up's own last step and is conditional on
      // every member having closed, which this call cannot know.
      expect(close).not.toContain("--delete-branch");
      expect(await records()).toEqual([
        ["lease"], comment,
        ["lease"], close,
      ]);
    });
  });

  // GitHub marks a pull request MERGED by itself once the landing push makes
  // its head reachable from the base, and refuses `gh pr close` from then on
  // — which is the routine outcome, not the exception. Driven through the
  // shim because what is under test is the real adapter's second question.
  describe("closing a chunk pull request the forge already marked merged", () => {
    const shim = (closeExit: number, state: string): Promise<void> =>
      writeFile(
        join(shimBin, "gh"),
        [
          "#!/bin/sh",
          `log='${argvLog}'`,
          'printf "[" >> "$log"',
          'sep=""',
          'for a in "$@"; do',
          '  printf \'%s"%s"\' "$sep" "$a" >> "$log"',
          '  sep=","',
          "done",
          'printf "]\\n" >> "$log"',
          'case "$*" in',
          `  "pr close"*) echo "X Pull request acme/app#9 can't be closed because it was already merged" >&2; exit ${closeExit} ;;`,
          `  "pr view"*) printf '{"state":"${state}"}' ;;`,
          "esac",
          "exit 0",
        ].join("\n") + "\n",
        { mode: 0o755 },
      );
    const adapter = () =>
      chunkForgeWrites({
        repo: REPO,
        gitCwd: "/nonexistent-bare-cache",
        errPrefix: "merger",
        beforeOriginWrite,
      });

    it("answers `merged` after reading the state back from the configured repo", async () => {
      await shim(1, "MERGED");

      await expect(adapter().closePullRequest(9)).resolves.toBe("merged");

      const [close, view] = await calls();
      expect(close?.slice(0, 3)).toEqual(["pr", "close", "9"]);
      expect(view?.slice(0, 3)).toEqual(["pr", "view", "9"]);
      expect(repoFlagOf(view ?? [])).toBe("acme/app");
      expect(view).toContain("--json");
      expect(view).toContain("state");
      // The read is a read: no lease barrier ahead of it.
      expect(await records()).toEqual([["lease"], close, view]);
    });

    it("answers `closed` without a second call when the close itself worked", async () => {
      await shim(0, "MERGED");

      await expect(adapter().closePullRequest(9)).resolves.toBe("closed");

      expect(await calls()).toHaveLength(1);
    });

    it("names both failures when the state cannot be read back either", async () => {
      await shim(1, "");
      await writeFile(
        join(shimBin, "gh"),
        (await readFile(join(shimBin, "gh"), "utf8")).replace(
          `"pr view"*) printf '{"state":""}' ;;`,
          `"pr view"*) echo "gh: forge unreachable" >&2; exit 1 ;;`,
        ),
        { mode: 0o755 },
      );

      await expect(adapter().closePullRequest(9)).rejects.toThrow(
        /failed to close pull request #9: .*already merged.*reading the pull request's state back also failed: .*forge unreachable/s,
      );
    });

    it("rethrows the close's own failure when the pull request is still open", async () => {
      await shim(1, "OPEN");

      await expect(adapter().closePullRequest(9)).rejects.toThrow(
        /merger: failed to close pull request #9: .*already merged/s,
      );
      expect(await calls()).toHaveLength(2);
    });
  });

  it("atomically deletes the chunk ref and its strict member refs", async () => {
    await writeFile(
      join(shimBin, "git"),
      [
        "#!/bin/sh",
        `log='${argvLog}'`,
        'printf "[" >> "$log"',
        'sep=""',
        'for a in "$@"; do',
        '  printf \'%s"%s"\' "$sep" "$a" >> "$log"',
        '  sep=","',
        "done",
        'printf "]\\n" >> "$log"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const adapter = chunkForgeWrites({
      repo: REPO,
      gitCwd: shimBin,
      errPrefix: "test",
      beforeOriginWrite,
    });

    await adapter.deleteChunkBranch("sandbar/chunk-42-root", [42, 43]);

    expect(await calls()).toEqual([[
      "push",
      "--atomic",
      "origin",
      "--delete",
      "refs/heads/sandbar/chunk-42-root",
      "refs/heads/sandbar/member-42",
      "refs/heads/sandbar/member-43",
    ]]);
    expect(await records()).toEqual([
      ["lease"],
      expect.arrayContaining(["push", "--atomic"]),
    ]);
  });

  // #64 — the two READS that decide which chunks are acted on at all. A wrong
  // repo here is SILENT: it answers "nothing to land, nothing to reconcile" and
  // the run simply never does either.
  describe("chunk discovery", () => {
    it("lists the land-labelled pull requests of the configured repo", async () => {
      await fetchLandRequestPullRequests(REPO, "land");

      const [argv] = await calls();
      expect(argv?.slice(0, 2)).toEqual(["pr", "list"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      const label = (argv ?? []).indexOf("--label");
      expect(argv?.[label + 1]).toBe("land");
      const state = (argv ?? []).indexOf("--state");
      expect(argv?.[state + 1]).toBe("open");
    });

    it("asks per branch for a chunk branch's pull request, in the configured repo", async () => {
      await fetchPullRequestsForBranches(REPO, [
        "sandbar/chunk-42-a",
        "sandbar/chunk-77-b",
      ]);

      const recorded = await calls();
      expect(recorded).toHaveLength(2);
      expect(recorded.map((argv) => argv[argv.indexOf("--head") + 1])).toEqual([
        "sandbar/chunk-42-a",
        "sandbar/chunk-77-b",
      ]);
      for (const argv of recorded) {
        expect(argv.slice(0, 2)).toEqual(["pr", "list"]);
        expect(repoFlagOf(argv)).toBe("acme/app");
      }
    });
  });
});

// Discovery FAILS SOFT, and this is the half of that claim a fake adapter can
// never show: what the readers do with a `gh` that answered something they
// cannot read. These run at PLAN time, before anything else in the cycle, so a
// throw out of one is not a degraded reconciliation — it is a run that does not
// start, over a repair that was never urgent.
describe("the forge readers fail soft (#64)", () => {
  let shimBin: string;
  let originalPath: string | undefined;
  const REPO_REF = { owner: "acme", name: "app" };

  // A `gh` that exits 0 and prints `body`, or exits 1 when `body` is null.
  const shimAnswering = async (body: string | null): Promise<void> => {
    await writeFile(
      join(shimBin, "gh"),
      body === null
        ? "#!/bin/sh\nexit 1\n"
        : `#!/bin/sh\ncat <<'SANDBAR_EOF'\n${body}\nSANDBAR_EOF\n`,
      { mode: 0o755 },
    );
  };

  beforeEach(async () => {
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-ghsoft-"));
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(shimBin, { recursive: true, force: true });
  });

  it("answers 'no requests' when gh cannot be run at all", async () => {
    await shimAnswering(null);
    expect(await fetchLandRequestPullRequests(REPO_REF, "land")).toEqual([]);
    expect(
      await fetchPullRequestsForBranches(REPO_REF, ["sandbar/chunk-42-c"]),
    ).toEqual([]);
  });

  it("answers 'no requests' on output that is not JSON at all", async () => {
    await shimAnswering("gh: could not resolve to a Repository");
    expect(await fetchLandRequestPullRequests(REPO_REF, "land")).toEqual([]);
  });

  it("drops the unreadable entries and keeps the rest", async () => {
    // One good, one missing `number`, one whose `headRefName` is the wrong
    // type. The good one must survive: dropping a whole list over one bad
    // element would strand a chunk a human labelled.
    await shimAnswering(
      JSON.stringify([
        { number: 9, headRefName: "sandbar/chunk-42-c", title: "chunk 42" },
        { headRefName: "sandbar/chunk-77-c", title: "no number" },
        { number: 11, headRefName: 404, title: "wrong type" },
      ]),
    );
    expect(await fetchLandRequestPullRequests(REPO_REF, "land")).toEqual([
      { number: 9, headRefName: "sandbar/chunk-42-c", title: "chunk 42" },
    ]);
  });

  it("tolerates a missing title, which is only ever prose", async () => {
    await shimAnswering(
      JSON.stringify([{ number: 9, headRefName: "sandbar/chunk-42-c" }]),
    );
    expect(await fetchLandRequestPullRequests(REPO_REF, "land")).toEqual([
      { number: 9, headRefName: "sandbar/chunk-42-c", title: "" },
    ]);
  });
});
