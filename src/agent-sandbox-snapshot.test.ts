// The seed snapshot sandbox (#203) against a local stub provider: the
// bringup failure path, the HEAD comparison in `changed()`, close's
// idempotence and a leftover snapshot's replacement. No container runs, so
// none of this needs the host-podman gate.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ProviderCreateOptions,
  type SandboxProvider,
  createSeedSnapshotSandbox,
} from "./agent-sandbox.js";
import { type RepoLayout, repoLayout } from "./repo-cache.js";

const exec = promisify(execFile);

describe("createSeedSnapshotSandbox with a stub provider (#203)", () => {
  let root: string;
  let layout: RepoLayout;
  let seedSha: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "asb-snapshot-stub-"));
    layout = repoLayout(root, ".sandbar");
    const source = join(root, "source");
    const git = (...args: string[]) =>
      exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: source });
    await exec("git", ["init", "-q", "-b", "main", source]);
    await writeFile(join(source, "seed.txt"), "seed\n");
    await git("add", "seed.txt");
    await git("commit", "-qm", "seed");
    seedSha = (await git("rev-parse", "HEAD")).stdout.trim();
    await exec("git", ["clone", "-q", "--bare", source, layout.repoDir]);
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stub = (create?: (o: ProviderCreateOptions) => Promise<void>): SandboxProvider => ({
    tag: "bind-mount",
    name: "stub",
    env: {},
    sandboxHomedir: "/home/agent",
    async create(o) {
      await create?.(o);
      return {
        worktreePath: "/home/agent/workspace",
        containerName: "stub-container",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        close: async () => {},
      };
    },
  });
  const open = (issueId: string, sandbox: SandboxProvider, notices: string[] = [], sha = seedSha) =>
    createSeedSnapshotSandbox({
      layout,
      issueId,
      seedSha: sha,
      sandbox,
      env: {},
      extraMounts: [],
      onNotice: (_severity, message) => {
        notices.push(message);
      },
    });
  const snapshotPath = (issueId: string) => join(layout.snapshotsDir, `issue-${issueId}-seed`);

  it("removes the snapshot and rethrows the original error when bringup fails", async () => {
    const notices: string[] = [];
    const boom = new Error("create refused");
    await expect(
      open("301", stub(() => Promise.reject(boom)), notices),
    ).rejects.toBe(boom);
    expect(existsSync(snapshotPath("301"))).toBe(false);
    expect(notices).toEqual([]);
  });

  it("removes the snapshot when the seed is not in the cache", async () => {
    const notices: string[] = [];
    await expect(open("302", stub(), notices, "0".repeat(40))).rejects.toThrow();
    expect(existsSync(snapshotPath("302"))).toBe(false);
    expect(notices).toEqual([]);
  });

  it("notices a failed removal after a bringup failure and still rethrows the original", async () => {
    const notices: string[] = [];
    const boom = new Error("create refused");
    // Replacing the snapshots directory with a file makes the removal ENOTDIR.
    const sandbox = stub(async () => {
      await rm(layout.snapshotsDir, { recursive: true, force: true });
      await writeFile(layout.snapshotsDir, "not a directory");
      throw boom;
    });
    try {
      await expect(open("303", sandbox, notices)).rejects.toBe(boom);
    } finally {
      await rm(layout.snapshotsDir, { recursive: true, force: true });
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Failed to remove seed snapshot after bringup failure");
  });

  it("reports a HEAD that moved and keeps the snapshot when close preserves it", async () => {
    const notices: string[] = [];
    const sandbox = await open("304", stub(), notices);
    await exec(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "x"],
      { cwd: sandbox.worktreePath },
    );
    expect(await sandbox.changed()).toContain(`HEAD moved from ${seedSha} to`);
    await sandbox.close({ preserve: "head moved" });
    expect(existsSync(sandbox.worktreePath)).toBe(true);
  });

  it("closes once: a second close emits no second notice", async () => {
    const notices: string[] = [];
    const sandbox = await open("305", stub(), notices);
    await sandbox.close({ preserve: "kept" });
    await sandbox.close({ preserve: "kept" });
    expect(notices).toHaveLength(1);
  });

  it("replaces a preserved snapshot when the same issue is opened again", async () => {
    const first = await open("306", stub());
    await writeFile(join(first.worktreePath, "stray.txt"), "left over\n");
    await first.close({ preserve: "kept" });
    expect(existsSync(join(first.worktreePath, "stray.txt"))).toBe(true);

    const second = await open("306", stub());
    try {
      expect(existsSync(join(second.worktreePath, "stray.txt"))).toBe(false);
      expect(await second.changed()).toBeNull();
    } finally {
      await second.close();
    }
  });
});
