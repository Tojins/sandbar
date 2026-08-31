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
// Asserted through a `gh` shim on PATH that records its own argv, driving the
// REAL adapters. The shim resolves nothing from the working directory: the
// point is only that `--repo <owner>/<name>` is present and correct, which is
// what a fake cannot see.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fetchLandRequestPullRequests,
  fetchPullRequestsForBranches,
  realReconcileAdapter,
} from "./chunk-reconcile.js";
import { realAdapter as realFinalizeAdapter } from "./finalize.js";
import { realAdapter as realMergerAdapter } from "./merger.js";
import { repoLayout } from "./repo-cache.js";

const REPO = { owner: "acme", name: "app" };

describe("the tracker WRITE calls name the repository (#34)", () => {
  let shimBin: string;
  let argvLog: string;
  let originalPath: string | undefined;

  // Every recorded invocation, as argv arrays.
  const calls = async (): Promise<string[][]> => {
    const raw = await readFile(argvLog, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string[]);
  };

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
      });

    it("posts the handoff comment to the configured repo", async () => {
      await adapter().postComment(42, "handoff body");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "comment", "42"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("handoff body");
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
      } as unknown as Parameters<typeof realMergerAdapter>[0]);

    it("comments the abandon/revert reason on the configured repo", async () => {
      await adapter().commentOnIssue(7, "reverted because…");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "comment", "7"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
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

    // #64 — parking a chunk, which only the merge phase ever does: the
    // reconciler has no merge that could fail. The wrong repository here is a
    // reviewer told nothing on a pull request that stays labelled `land`, so
    // the same failing merge is retried every cycle.
    it("drops the land label on the configured repo", async () => {
      await adapter().removePullRequestLabel(9, "land");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["pr", "edit", "9"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("--remove-label");
      expect(argv).toContain("land");
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
        } as unknown as Parameters<typeof realMergerAdapter>[0]),
    ],
    [
      "reconciler",
      () => realReconcileAdapter({ repoDir: "/nonexistent-bare-cache", repo: REPO }),
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
    });

    // The same call the auto lane drops `ready-for-agent` with, which is why it
    // is not spelled twice either.
    it("drops a label in the configured repo", async () => {
      await adapter().removeLabel(7, "in-chunk");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "edit", "7"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("--remove-label");
      expect(argv).toContain("in-chunk");
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
    });
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
