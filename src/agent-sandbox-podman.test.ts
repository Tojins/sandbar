// What PODMAN defines about `--init` (#42), asserted by running podman — the
// same argument gate-stack-podman.test.ts and ensure-images-podman.test.ts
// make. `sandboxRunArgs` in agent-sandbox.test.ts proves sandbar emits the flag
// it means to and puts it where podman will read it; only podman can prove that
// the flag actually changes who pid 1 is and that the new pid 1 reaps.
//
// The control half is the point of the file. An assertion that a sandbox
// carries no zombies is vacuous unless the orphan it plants would otherwise
// become one — a `sleep` that exits *before* its parent, an exec that never
// forked, a /proc read that finds nothing, all pass just as happily. So the
// same argv runs twice, once with `--init` filtered back out, and the pair
// pins the difference rather than the flag.
//
// Not merged into agent-sandbox.test.ts: that file is podman-free by design (it
// drives a fake provider against a real temp git repo), and this one needs a
// real podman and a real image.
//
// IT RUNS IN THE GATE (#52), in the `podman-test` step beside
// gate-stack-podman.test.ts and ensure-images-podman.test.ts, over the host's
// podman through the socket #48 mounted. #48 left it host-only on an explicit
// UNKNOWN rather than a measured difference — whether `--init` reaping observes
// the same way through a remote client was exactly the sort of thing this file
// exists to establish empirically rather than assume — and the measurement came
// back the same both ways.
//
// Unsurprising in hindsight, and the reason is written down rather than left to
// be re-derived: every assertion here is made INSIDE the target container, by
// `podman exec`ing a `/proc` read. Nothing in it depends on the caller's
// network namespace, its filesystem, or its signal handling. Those three are
// what keep work host-only elsewhere — the retired tcp readiness pair landed
// its publish on the host's loopback while the probe ran in the runner's pod
// netns, and gate-stack-hostpodman.test.ts reads the host session's systemd
// units. This file touches none of them.
//
// SO IT IS NO LONGER PART OF THE HUMAN'S STEP. #48 shrank that step from "run
// the full suite on the host" to three files; #141's host-side cgroup-path
// assertion makes the remaining manual set three files:
// gate-stack-hostpodman.test.ts, sandbox-stack-podman.test.ts, and
// container-resources-podman.test.ts, each
// host-only because a remote client demonstrably does something else rather
// than because nobody looked. Prose describing that step is load-bearing in
// both directions: naming this file still sends a human to re-run what the gate
// now runs every attempt, and dropping either of the other two leaves its
// assertions exercised by nobody, with nothing saying so.
//
// The second suite (#189) asks the same kind of question of the agent's process
// group: whether an end that kills only the exec client leaves the agent and
// its background children alive in the container, and whether the reap does
// not. It has a control for the same reason the first one does.
//
// The third (#203) asks it of the seed snapshot: that a `:ro` mount refuses
// the agent's writes while git can still read the tree. It needs git in the
// container, which no stock image here carries, so it builds alpine plus git
// once per file (a network pull, as ensure-images-podman.test.ts already makes).
// The fourth (#238) mounts the verifier's workspace read-write through the
// same provider and asks whether the host can move and remove what the agent
// wrote there, and whether the agent sees anything beside it.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, it } from "vitest";

import { scopedResourcePrefix } from "./naming.js";
import { repoLayout, type RepoLayout } from "./repo-cache.js";
import { podmanExecOutput } from "./podman-exec.test-util.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  removeFixtureContainerOnTestFinished,
} from "./podman-test-scope.test-util.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  type AgentProvider,
  type SandboxProvider,
  agentProcessGroupCommand,
  createSandbox,
  createSeedSnapshotSandbox,
  parseStreamJsonLine,
  podman,
  podmanExec,
  reapProcessGroupCommand,
  sandboxRunArgs,
} from "./agent-sandbox.js";
import { withRuntimeEnv } from "./runtime.js";
import {
  archiveRun,
  clearRunDir,
  prepareVerifierWorkspace,
  restageFindings,
} from "./verifier-run.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// Any local image with a shell and a `sleep`. mariadb is what the other podman
// test files already require, so this file adds no new pull.
const IMAGE = "docker.io/library/mariadb:10.11";

// Resolved at COLLECTION time, not in beforeAll: vitest evaluates `runIf`
// while building the suite, so a flag set in a hook arrives too late and
// silently skips everything — a test file that always passes by never running.
//
// No `needsLocalClient`, which is the whole of the wiring change (#52): the
// `podman-test` step's `podman.test.ts` filter collects this file, and it is not
// one of that step's three explicit local-client exclusions. Dropping the flag is
// also what makes `SANDBAR_REQUIRE_PODMAN_TESTS=1` reach these two tests — under
// it an unreachable podman is a failing test here rather than a silent skip,
// which is the point of putting the file in a step at all.
const available = podmanTestsEnabled({
  what: "agent-sandbox podman tests",
  image: IMAGE,
});

// Container names carry this process's SCOPE (#47), where they used to be a
// bare uuid. #47 audited this file and cleared it, correctly — the question it
// asked was COLLISION, and against a uuid the answer needs nothing from a
// scope. The debris report asks a different question:
// `findUnattributableResources` names every `sandbar-`-prefixed resource that
// fails `isScopedResourceName`, nothing sweeps it, and it repeats at every
// startup until an operator clears it by hand. A per-test finished hook removes
// these, so
// only a SIGKILL leaks one — and moving into the gate is precisely what changes
// those odds, from a human running the file occasionally to three runners on
// every cycle. With the scope carrying the uniqueness, the per-container part
// of the name is free to be the one thing a human reading debris wants from
// it: which of the two variants this was.
const { scope: SCOPE, testImageTag, cleanup } = podmanTestScope("agent-sandbox");

// This process's own scoped sweep, for whatever a finished hook did not reach.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe.runIf(available)("the sandbox container against real podman", () => {
  // Rootless podman 4.9 can race two simultaneous keep-id container creates
  // while both runtimes write `ping_group_range`, rejecting one with EINVAL.
  // Serialize only that short create operation; the two test bodies and their
  // deliberate orphan/reaping waits still overlap.
  let previousStart: Promise<void> = Promise.resolve();

  // The production argv, verbatim, with `--init` kept or filtered out — the
  // only axis this file has. Taking that axis rather than a list of flags to
  // drop is what lets the container's NAME state which variant it is without
  // the two being able to disagree: one argument decides both, so a leftover
  // `…-noinit` can only ever be a container that really was started without it.
  const start = async (init: "with-init" | "without-init"): Promise<string> => {
    const name = `${scopedResourcePrefix(SCOPE)}initprobe-${randomUUID()}-${
      init === "with-init" ? "init" : "noinit"
    }`;
    const { argv, env } = sandboxRunArgs({
      containerName: name,
      imageName: IMAGE,
      // Not the real sandbox paths: this image has neither, and `-w` is not
      // what is under test.
      workdir: "/tmp",
      env: {},
      volumeMounts: [],
      userns: "keep-id",
      containerUid: 1000,
      containerGid: 1000,
      networks: [],
      dnsArgs: [],
      groups: [],
      devices: [],
      cpus: undefined,
    });
    const filtered = argv.filter((a) => init === "with-init" || a !== "--init");
    const started = previousStart.then(async () => {
      // Through the production helper, which is how an invocation becomes a
      // command (#154). Inert for this fixture's empty `env` — sandbox-stack-
      // podman.test.ts is the one that runs a real env file past real podman.
      await withRuntimeEnv({ argv: filtered, env }, (a) => exec(RUNTIME, a));
    });
    previousStart = started.catch(() => {});
    await started;
    return name;
  };

  // Fork a process and let its parent exit first, exactly as a test runner's
  // browser or a build's worker does. The `podman exec` returns as soon as the
  // inner `sh` exits, leaving `sleep` orphaned and reparented to pid 1.
  const orphan = (name: string): Promise<unknown> =>
    exec(RUNTIME, ["exec", name, "sh", "-c", 'sh -c "sleep 1 & exit 0"']);

  // /proc, not `ps`: procps is not in every image, and `/proc/<pid>/stat` is
  // world-readable whatever uid the container runs as. Field 3 is the state
  // letter, and it follows the `)` that closes the comm field.
  const zombieCount = async (name: string): Promise<number> => {
    const stdout = await podmanExecOutput(name, ["sh", "-c", "cat /proc/[0-9]*/stat"]);
    return stdout.split("\n").filter((l) => /\)\s+Z\s/.test(l)).length;
  };

  // The control's claim — a zombie APPEARED — is satisfiable by waiting, so it
  // polls to a deadline instead of sleeping a fixed interval: it returns the
  // moment the orphan's `sleep 1` has exited and been left unreaped, and no
  // amount of contention between three concurrent gate stacks and one podman
  // can make it report early. Its mirror cannot be written this way and is not
  // — "none yet" and "none ever" are the same observation, so the `toBe(0)`
  // assertions keep the fixed settle below, which is what makes them mean
  // anything. Returns the last count rather than throwing, so a deadline that
  // does expire fails as the assertion it belongs to.
  const waitForZombie = async (name: string): Promise<number> => {
    const deadline = performance.now() + 30_000;
    for (;;) {
      const n = await zombieCount(name);
      if (n > 0 || performance.now() >= deadline) return n;
      await delay(250);
    }
  };

  const pid1Comm = async (name: string): Promise<string> =>
    (await podmanExecOutput(name, ["cat", "/proc/1/comm"])).trim();

  it.concurrent(
    "leaks a zombie per orphan when pid 1 is the sleep entrypoint",
    async ({ expect, onTestFinished }) => {
      const name = await start("without-init");
      removeFixtureContainerOnTestFinished(onTestFinished, name);
      // The control's own premise: without --init, `sleep infinity` is pid 1.
      expect(await pid1Comm(name)).toBe("sleep");

      await orphan(name);
      expect(await waitForZombie(name)).toBeGreaterThan(0);
    },
    60_000,
  );

  it.concurrent(
    "reaps the same orphan under --init",
    async ({ expect, onTestFinished }) => {
      const name = await start("with-init");
      removeFixtureContainerOnTestFinished(onTestFinished, name);
      // podman's init takes pid 1 and the entrypoint becomes its child; the
      // binary's comm has been both `catatonit` and `podman-init` across
      // versions, so what is asserted is that `sleep` is no longer pid 1.
      expect(await pid1Comm(name)).not.toBe("sleep");

      await orphan(name);
      // Fixed, and it has to be: nothing distinguishes "reaped" from "the
      // orphan has not exited yet" except having waited longer than it takes.
      // Comfortably over the orphan's own `sleep 1`.
      await delay(2500);
      expect(await zombieCount(name)).toBe(0);

      // And it keeps reaping — the count is monotonic without a reaper, so a
      // second orphan is what separates "reaped" from "hasn't arrived yet".
      await orphan(name);
      await delay(2500);
      expect(await zombieCount(name)).toBe(0);
    },
    60_000,
  );

  // #257: a sibling in the agent's netns may carry the egress proxy's secret
  // over it, so the agent must hold neither capability that captures traffic,
  // in its bounding set as well as its effective one.
  it.concurrent(
    "holds neither CAP_NET_RAW nor CAP_NET_ADMIN",
    async ({ expect, onTestFinished }) => {
      const name = await start("with-init");
      removeFixtureContainerOnTestFinished(onTestFinished, name);
      const status = await podmanExecOutput(name, ["cat", "/proc/self/status"]);
      const NET_ADMIN_AND_RAW = (1n << 12n) | (1n << 13n);
      for (const field of ["CapEff", "CapBnd"]) {
        const mask = new RegExp(`^${field}:\\s*([0-9a-f]+)$`, "m").exec(status)?.[1];
        expect(mask, field).toBeDefined();
        expect(BigInt(`0x${mask}`) & NET_ADMIN_AND_RAW, field).toBe(0n);
      }
    },
    60_000,
  );
});

// #189: what the in-container reap does, asserted where only podman can say —
// killing the `podman exec` client is all `invokeAgent` used to do, and that
// reaps nothing inside the container. The control runs the same wrapped agent
// and kills only the client; the three runs drive the real `invokeAgent` over
// the real exec wiring (`podmanExec`), so each of its forced ends is asserted
// by what is left in the container's /proc. No bind mount: the issue clone
// stays on the runner, and git setup — the one thing this image cannot do —
// is answered on the host side of the provider.
describe.runIf(available)("an agent's process group against real podman (#189)", () => {
  let name: string;
  let repo: string;

  beforeAll(async () => {
    name = `${scopedResourcePrefix(SCOPE)}pgroup-${randomUUID()}`;
    const { argv, env } = sandboxRunArgs({
      containerName: name,
      imageName: IMAGE,
      workdir: "/tmp",
      env: {},
      volumeMounts: [],
      userns: "keep-id",
      containerUid: 1000,
      containerGid: 1000,
      networks: [],
      dnsArgs: [],
      groups: [],
      devices: [],
      cpus: undefined,
    });
    await withRuntimeEnv({ argv, env }, (a) => exec(RUNTIME, a));
    repo = await mkdtemp(join(tmpdir(), "asb-podman-189-"));
    const git = (...args: string[]) =>
      exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    await git("init", "-b", "main");
    await git("commit", "--allow-empty", "-m", "seed");
    await git("branch", "sandbar/issue-189-podman");
  }, 120_000);

  afterAll(async () => {
    if (name) await exec(RUNTIME, ["rm", "-f", "-t", "0", name]).catch(() => undefined);
    if (repo) await rm(repo, { recursive: true, force: true });
  }, 60_000);

  // Field 5 of /proc/<pid>/stat is the process group, after the `)` that
  // closes comm; zombies are excluded because --init reaps them.
  const groupMembers = async (pgid: string): Promise<number> => {
    const stdout = await podmanExecOutput(name, ["sh", "-c", "cat /proc/[0-9]*/stat 2>/dev/null"]);
    return stdout.split("\n").filter((l) => {
      const fields = l.slice(l.lastIndexOf(")") + 2).split(" ");
      return fields[0] !== "Z" && fields[2] === pgid;
    }).length;
  };
  const readPgid = async (tag: string): Promise<string> => {
    const deadline = performance.now() + 10_000;
    for (;;) {
      const { stdout } = await exec(RUNTIME, ["exec", name, "sh", "-c", `cat /tmp/${tag}.pgid 2>/dev/null || true`]);
      if (stdout.trim() !== "" || performance.now() >= deadline) return stdout.trim();
      await delay(100);
    }
  };
  const settlesEmpty = async (pgid: string): Promise<number> => {
    const deadline = performance.now() + 10_000;
    for (;;) {
      const n = await groupMembers(pgid);
      if (n === 0 || performance.now() >= deadline) return n;
      await delay(100);
    }
  };
  // The agent records its own group, leaves a background child in it, emits
  // what the path needs, then holds the exec open.
  const agentScript = (tag: string, emit: string): string =>
    `sed 's/.*) //' /proc/$$/stat | cut -d' ' -f3 > /tmp/${tag}.pgid; ` +
    `sleep 300 & ${emit}; sleep 300`;
  const line = (obj: unknown): string => `printf '%s\\n' '${JSON.stringify(obj)}'`;

  it("survives a killed exec client: the control", async ({ expect }) => {
    const pidfile = "/tmp/control-reap.pgid";
    const client = spawn(RUNTIME, [
      "exec", name, "sh", "-c",
      agentProcessGroupCommand(agentScript("control", "true"), pidfile),
    ], { stdio: "ignore" });
    const pgid = await readPgid("control");
    expect(pgid).toMatch(/^\d+$/);
    client.kill("SIGKILL");
    await new Promise((r) => client.on("close", r));
    await delay(1000);
    expect(await groupMembers(pgid)).toBeGreaterThan(1);

    await exec(RUNTIME, ["exec", name, "sh", "-c", reapProcessGroupCommand(pidfile)]);
    expect(await settlesEmpty(pgid)).toBe(0);
  }, 60_000);

  it("leaves nothing of the group alive on the accepted, idle and completion ends", async ({ expect }) => {
    const containerExec = podmanExec(name);
    const provider: SandboxProvider = {
      tag: "bind-mount",
      name: "podman",
      env: {},
      sandboxHomedir: "/home/agent",
      create: async (o) => ({
        worktreePath: o.worktreePath,
        containerName: name,
        exec: (command, opts) => command.startsWith("git config")
          ? Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })
          : containerExec(command, { ...opts, cwd: "/tmp" }),
        close: async () => {},
      }),
    };
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-189-podman",
      sandbox: provider,
      layout: {
        hostCwd: repo,
        stateDir: join(repo, ".sandbar"),
        repoDir: repo,
        worktreesDir: join(repo, ".sandbar", "worktrees"),
        sourceWorktree: join(repo, ".sandbar", "worktrees", "source"),
        logsDir: join(repo, ".sandbar", "logs"),
      },
    });
    const agent = (script: string): AgentProvider => ({
      name: "claude-code",
      env: {},
      buildPrintCommand: () => ({ command: script, stdin: "" }),
      parseStreamLine: parseStreamJsonLine,
    });
    try {
      const accepted = await sandbox.run({
        agent: agent(agentScript("accepted", line({
          type: "result", subtype: "success", is_error: false, result: "done",
        }))),
        prompt: "go",
        completionSignal: [],
        completionTimeoutSeconds: 1,
        idleTimeoutSeconds: 60,
      });
      expect(accepted.endedBy).toBe("result-then-silence");
      expect(await settlesEmpty(await readPgid("accepted"))).toBe(0);

      const idle = await sandbox.run({
        agent: agent(agentScript("idle", "true")),
        prompt: "go",
        completionSignal: [],
        idleTimeoutSeconds: 1,
      }).then(() => null, (e: unknown) => e);
      expect(idle).toBeInstanceOf(AgentIdleTimeoutError);
      expect(await settlesEmpty(await readPgid("idle"))).toBe(0);

      const completion = await sandbox.run({
        agent: agent(agentScript("completion", line({
          type: "assistant",
          message: { content: [{ type: "text", text: "<promise>COMPLETE</promise>" }] },
        }))),
        prompt: "go",
        completionSignal: ["<promise>COMPLETE</promise>"],
        completionTimeoutSeconds: 1,
        idleTimeoutSeconds: 60,
      }).then(() => null, (e: unknown) => e);
      expect(completion).toBeInstanceOf(AgentError);
      expect(await settlesEmpty(await readPgid("completion"))).toBe(0);
    } finally {
      await sandbox.close();
    }
  }, 120_000);
});

// #203: the seed snapshot through the real provider. The cache holds a seed,
// a tag and an issue branch one commit past the seed; the snapshot must carry
// the seed's tree and none of those refs, and its container must refuse a
// write that git's own reads survive.
const GIT_BASE = "docker.io/library/alpine:3.22";
const snapshotAvailable = podmanTestsEnabled({
  what: "seed snapshot podman tests",
  image: GIT_BASE,
});

describe.runIf(snapshotAvailable)("a seed snapshot sandbox against real podman (#203)", () => {
  let imageName: string;
  let root: string;
  let layout: RepoLayout;
  let seedSha: string;

  beforeAll(async () => {
    imageName = testImageTag("seed-snapshot-git");
    const context = await mkdtemp(join(tmpdir(), "asb-podman-203-image-"));
    try {
      await writeFile(
        join(context, "Containerfile"),
        `FROM ${GIT_BASE}\nRUN apk add --no-cache git && adduser -D -u 1000 -h /home/agent agent\n`,
      );
      // Without Buildah's layer cache: its lookup reads every image in the
      // shared store, and one another test removes mid-scan fails this build
      // with `layer not known` (ensure-images-podman.test.ts).
      await exec(RUNTIME, ["build", "-q", "--layers=false", "-t", imageName, context]);
    } finally {
      await rm(context, { recursive: true, force: true });
    }

    root = await mkdtemp(join(tmpdir(), "asb-podman-203-"));
    layout = repoLayout(root, ".sandbar");
    const source = join(root, "source");
    const git = (...args: string[]) =>
      exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: source });
    await exec("git", ["init", "-q", "-b", "main", source]);
    await writeFile(join(source, "seed.txt"), "seed\n");
    await git("add", "seed.txt");
    await git("commit", "-qm", "seed");
    await git("tag", "v1");
    seedSha = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "-qb", "sandbar/issue-203-snapshot");
    await writeFile(join(source, "work.txt"), "implementer\n");
    await git("add", "work.txt");
    await git("commit", "-qm", "implementer work");
    await exec("git", ["clone", "-q", "--bare", source, layout.repoDir]);
  }, 600_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  const open = (issueId: string, notices: string[] = []) =>
    createSeedSnapshotSandbox({
      layout,
      issueId,
      seedSha,
      sandbox: podman({ imageName, namePrefix: scopedResourcePrefix(SCOPE) }),
      env: {},
      extraMounts: [],
      onNotice: (_severity, message) => {
        notices.push(message);
      },
    });
  const snapshotGit = async (path: string, ...args: string[]) =>
    (await exec("git", args, { cwd: path })).stdout.trim();
  const containerExists = (name: string): Promise<boolean> =>
    exec(RUNTIME, ["container", "exists", name]).then(() => true, () => false);

  it.concurrent("is the seed, detached, with no refs and no origin, read-only to its agent", async ({ expect }) => {
    const sandbox = await open("203");
    try {
      expect(sandbox.worktreePath).toBe(join(layout.snapshotsDir, "issue-203-seed"));
      expect(await snapshotGit(sandbox.worktreePath, "rev-parse", "HEAD")).toBe(seedSha);
      await expect(snapshotGit(sandbox.worktreePath, "symbolic-ref", "-q", "HEAD")).rejects.toThrow();
      expect(await snapshotGit(sandbox.worktreePath, "for-each-ref")).toBe("");
      expect(await snapshotGit(sandbox.worktreePath, "remote")).toBe("");
      expect(existsSync(join(sandbox.worktreePath, "work.txt"))).toBe(false);

      // Through `run`, so the safe.directory it sets is the one git reads by.
      const probe =
        "if touch x 2>/dev/null; then t=wrote; else t=refused; fi; " +
        "h=$(git log -1 --format=%H) && s=$(git status --porcelain) && " +
        "printf '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"%s %s [%s]\"}\\n' \"$t\" \"$h\" \"$s\"";
      const agent: AgentProvider = {
        name: "claude-code",
        env: {},
        buildPrintCommand: () => ({ command: probe, stdin: "" }),
        parseStreamLine: parseStreamJsonLine,
      };
      const result = await sandbox.run({
        agent,
        prompt: "go",
        completionSignal: [],
        idleTimeoutSeconds: 60,
      });
      expect(result.stdout).toBe(`refused ${seedSha} []`);
      expect("commits" in result).toBe(false);
      expect(await sandbox.changed()).toBeNull();
    } finally {
      await sandbox.close();
    }
    expect(await containerExists(sandbox.containerName)).toBe(false);
    expect(existsSync(sandbox.worktreePath)).toBe(false);
  }, 120_000);

  it.concurrent("reports a change and keeps the snapshot when close preserves it", async ({ expect }) => {
    const notices: string[] = [];
    const sandbox = await open("204", notices);
    try {
      await writeFile(join(sandbox.worktreePath, "stray.txt"), "host write\n");
      expect(await sandbox.changed()).toContain("?? stray.txt");
    } finally {
      await sandbox.close({ preserve: "the scenario writer wrote" });
    }
    expect(await containerExists(sandbox.containerName)).toBe(false);
    expect(existsSync(join(sandbox.worktreePath, "stray.txt"))).toBe(true);
    expect(notices).toEqual([
      `Seed snapshot preserved at ${sandbox.worktreePath}: the scenario writer wrote`,
    ]);
  }, 120_000);

  // #238: the verifier's workspace, mounted read-write through the same
  // provider. The agent's files there belong to the host user (keep-id), so
  // the host can archive, restage and remove them, and nothing of the host
  // directory around the workspace is visible to the agent.
  it.concurrent("mounts the verifier workspace so the host owns what the agent wrote there, and nothing beside it", async ({ expect }) => {
    const issueLogs = join(root, "logs", "issue-238");
    const workspace = join(issueLogs, "verifier-workspace");
    await prepareVerifierWorkspace(workspace);
    await writeFile(join(issueLogs, "beside.txt"), "SIBLING-SECRET\n");
    await clearRunDir(workspace);
    const sandbox = await createSeedSnapshotSandbox({
      layout,
      issueId: "238",
      seedSha,
      sandbox: podman({ imageName, namePrefix: scopedResourcePrefix(SCOPE) }),
      env: {},
      extraMounts: [{ hostPath: workspace, sandboxPath: "/sandbar/verifier" }],
      onNotice: () => undefined,
    });
    try {
      const probe =
        "mkdir -p /sandbar/verifier/run/S1 && echo evidence > /sandbar/verifier/run/S1/out.txt && " +
        "l=$(ls -A /sandbar) && " +
        "if grep -rqs SIBLING-SECRET / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev; " +
        "then s=seen; else s=unseen; fi; " +
        "printf '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"%s %s\"}\\n' \"$l\" \"$s\"";
      const agent: AgentProvider = {
        name: "claude-code",
        env: {},
        buildPrintCommand: () => ({ command: probe, stdin: "" }),
        parseStreamLine: parseStreamJsonLine,
      };
      const result = await sandbox.run({ agent, prompt: "go", completionSignal: [], idleTimeoutSeconds: 60 });
      expect(result.stdout).toBe("verifier unseen");
    } finally {
      await sandbox.close();
    }
    const roundDir = join(root, "run", "issue-238", "verifier", "round-1");
    await archiveRun(workspace, roundDir);
    await restageFindings(workspace, [{ id: "S1", roundDir }]);
    expect(await readFile(join(roundDir, "S1", "out.txt"), "utf8")).toBe("evidence\n");
    expect(await readFile(join(workspace, "findings", "S1", "out.txt"), "utf8")).toBe("evidence\n");
    await rm(roundDir, { recursive: true });
    await prepareVerifierWorkspace(workspace);
    expect(existsSync(join(workspace, "findings"))).toBe(false);
  }, 120_000);
});

