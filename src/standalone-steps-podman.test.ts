// The early run of standalone steps (#247) against real podman, over the host
// socket like the gate-stack family (not host-only). What the copy is for is
// a property of podman, not of the argv: a read-only worktree whose `.git`
// tmpfs podman fills by copy-up, so a step's `git` reads the clone's history
// and refs while nothing it writes reaches the clone, and `--network none`.
//
// The image is this installation's own sandbox and runner image
// (deploy/ansible/installations/sandbar), the one local image that carries
// git; without it the file skips, or fails under SANDBAR_REQUIRE_PODMAN_TESTS.

import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { type GateStep, resolveGateStack } from "./config.js";
import { standaloneContainerNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";
import { runStandaloneSteps } from "./standalone-steps.js";

const exec = promisify(execFile);

const GIT_IMAGE = "localhost/sandbar-agent:latest";

const available = podmanTestsEnabled({ what: "standalone-steps podman tests", image: GIT_IMAGE });

const { scope: SCOPE, cleanup } = podmanTestScope("standalone-steps");

afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

// A clone with two commits, `origin/main` at the first, and a file the second
// adds.
async function cloneWithHistory(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "sandbar-standalone-"));
  const git = (...args: string[]) =>
    exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "seed");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(join(repo, "added.ts"), "export {};\n");
  await git("add", "added.ts");
  await git("commit", "-q", "-m", "branch work");
  return repo;
}

// One held container whose readiness and setup would both fail: the copy runs
// neither.
const runOn = (repo: string, stackId: string, steps: readonly Omit<GateStep, "in">[]) =>
  runStandaloneSteps({
    scope: SCOPE,
    stackId,
    stack: resolveGateStack({
      containers: [{
        name: "runner",
        image: GIT_IMAGE,
        mountWorktree: "/app",
        env: { GREETING: "from-env" },
        readiness: { kind: "healthcheck", command: ["false"] },
        postReadyCommands: [["false"]],
      }],
      steps: steps.map((step) => ({ ...step, in: "runner", standalone: true })),
    }),
    worktreePath: repo,
    images: null,
    signal: undefined,
  });

const containerExists = async (name: string): Promise<boolean> =>
  exec(RUNTIME, ["container", "exists", name]).then(() => true, () => false);

describe.runIf(available)("runStandaloneSteps against podman (#247)", () => {
  it("runs a step that reads the branch's history and diffs against an origin ref, in its container's env", async () => {
    const repo = await cloneWithHistory();
    try {
      const [run] = await runOn(repo, "history", [{
        name: "diff",
        command: ["sh", "-c", "git log --format=%s && git diff --name-only origin/main && echo \"$GREETING\""],
      }]);
      expect(run).toMatchObject({
        result: "passed",
        exitCode: 0,
        image: GIT_IMAGE,
        output: "branch work\nseed\nadded.ts\nfrom-env\n",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it("cannot write the worktree, keeps its .git writes from the clone, and runs every step past a red", async () => {
    const repo = await cloneWithHistory();
    try {
      const runs = await runOn(repo, "readonly", [
        { name: "write", command: ["touch", "/app/new.ts"] },
        { name: "ref", command: ["git", "update-ref", "refs/heads/probe", "HEAD"] },
        { name: "red", command: ["sh", "-c", "echo 'src/a.ts:1 inline it'; exit 3"] },
      ]);
      expect(runs.map((run) => [run.step.name, run.result, run.exitCode])).toEqual([
        ["write", "failed", 1],
        ["ref", "passed", 0],
        ["red", "failed", 3],
      ]);
      expect(runs[0]!.output).toContain("Read-only file system");
      expect(runs[2]!.output).toBe("src/a.ts:1 inline it\n");
      await expect(access(join(repo, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/probe"]))
        .rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it("has no network but loopback", async () => {
    const repo = await cloneWithHistory();
    try {
      const [run] = await runOn(repo, "network", [{ name: "net", command: ["ls", "/sys/class/net"] }]);
      expect(run).toMatchObject({ result: "passed", output: "lo\n" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it("kills a step at its timeoutMs and removes the copy, which ran under its scoped name", async () => {
    const repo = await cloneWithHistory();
    const name = standaloneContainerNameFor(SCOPE, "timeout", "runner");
    try {
      let sawCopy = false;
      const fanOut = runOn(repo, "timeout", [{ name: "hang", command: ["sleep", "60"], timeoutMs: 5_000 }]);
      const watch = (async () => {
        for (let i = 0; i < 40 && !sawCopy; i += 1) {
          sawCopy = await containerExists(name);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })();
      const [run] = await fanOut;
      await watch;
      expect(run).toMatchObject({ result: "timed-out", exitCode: null });
      expect(run!.durationMs).toBeGreaterThanOrEqual(5_000);
      expect(sawCopy).toBe(true);
      expect(await containerExists(name)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);
});
