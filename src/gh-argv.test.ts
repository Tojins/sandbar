// #34 — the argv of the `gh` calls that WRITE to the tracker.
//
// `finalize.ts` and `merger.ts` are adapter-driven, and every test that drives
// them uses a fake. That is the blind spot CLAUDE.md names explicitly: a fake
// satisfies the contract no matter what argv the real adapter builds. These six
// calls are the ones that post a human's handoff comment, flip the queue label
// and CLOSE the issue — so "which repository" being wrong here is not a
// degraded prompt, it is a comment nobody reads and an issue closed in the
// wrong place.
//
// Asserted through a `gh` shim on PATH that records its own argv, driving the
// REAL adapters. The shim resolves nothing from the working directory: the
// point is only that `--repo <owner>/<name>` is present and correct, which is
// what a fake cannot see.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

    it("drops the queue label on the configured repo", async () => {
      await adapter().removeLabel(7, "ready-for-agent");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "edit", "7"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("--remove-label");
    });

    // #62 — the chunk PR is a WRITE too, and the wrong repo here is a review
    // surface opened where nobody is looking while the branch grows elsewhere.
    it("opens the chunk PR as a draft, in the configured repo, against the source branch", async () => {
      // A real cwd, unlike the three above: this call runs `gh` FROM the
      // merger worktree (as forge-verify's PR calls do), so a directory that
      // does not exist fails the spawn before any argv is recorded.
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

    // #64 — the three pull-request writes that land or park a chunk. The wrong
    // repository here is a reviewer told nothing on a pull request that stays
    // labelled `land`, so the same failing merge is retried every cycle.
    it("comments on the chunk pull request in the configured repo", async () => {
      await adapter().commentOnPullRequest(9, "landed");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["pr", "comment", "9"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
    });

    it("drops the land label on the configured repo", async () => {
      await adapter().removePullRequestLabel(9, "land");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["pr", "edit", "9"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      expect(argv).toContain("--remove-label");
      expect(argv).toContain("land");
    });

    it("closes the chunk pull request in the configured repo, keeping its branch", async () => {
      await adapter().closePullRequest(9);

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["pr", "close", "9"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
      // The branch delete is the wrap-up's own last step and is conditional on
      // every member having closed, which this call cannot know.
      expect(argv).not.toContain("--delete-branch");
    });

    // The sharpest of the six: closing an issue in the wrong repository is the
    // one write that is not merely noise to whoever receives it.
    it("closes the issue in the configured repo", async () => {
      await adapter().closeIssue(7, "merged");

      const [argv] = await calls();
      expect(argv?.slice(0, 3)).toEqual(["issue", "close", "7"]);
      expect(repoFlagOf(argv ?? [])).toBe("acme/app");
    });
  });
});
