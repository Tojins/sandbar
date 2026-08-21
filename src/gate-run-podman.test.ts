// `sandbar gate` end to end, against real podman (#45).
//
// The pure layers are pinned elsewhere — `parseArgs` in cli.test.ts,
// `gateReuseToken` in gate-run.test.ts, the reuse/keep/dirty accommodations in
// gate-stack-podman.test.ts. What only a real run can show is the thing a
// consumer actually invokes: does the command produce the exit code its
// contract promises, and does it leave nothing behind.
//
// The second half is the one worth a file. `runGateCommand` returns a number
// rather than exiting, which makes it callable twice in one process — and the
// obvious teardown (`runCleanup()`) is drained once per PROCESS, so a second
// call would have leaked its whole stack, silently, with a green verdict. That
// is invisible to any single-invocation test, so both calls are made here and
// the pod is asserted gone after each.
//
// The config deliberately builds nothing: `images` names a tag that already
// exists, so `ensureImages` skips it. What a build does is
// ensure-images-podman.test.ts's subject; this file is about the command's
// lifecycle, and a multi-minute build inside it would only make it flakier.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunConfig } from "./config.js";
import {
  GATE_EXIT_GREEN,
  GATE_EXIT_NO_VERDICT,
  GATE_EXIT_RED,
  GATE_STACK_ID,
  runGateCommand,
} from "./gate-run.js";
import { gateScope, podNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const IMAGE = "docker.io/library/mariadb:10.11";

// Collection time, not beforeAll — a `runIf` flag set in a hook arrives after
// the suite is built and silently skips everything. Under
// `SANDBAR_REQUIRE_PODMAN_TESTS=1` an unreachable podman is a failing test.
const available = podmanTestsEnabled({
  what: "gate-run podman tests",
  image: IMAGE,
});

// No `podmanTestScope` here, and that is the point rather than an omission:
// the scope under test is the one `gateScope` derives from the worktree, and
// substituting a per-process one would test a scope the command never
// computes. Concurrency safety comes from the worktree instead — `mkdtemp`
// gives every process its own, so every process gets its own scope, which is
// the same guarantee by the production route.
describe.runIf(available)("sandbar gate against real podman", () => {
  let repo: string;
  let podName: string;

  const config = (steps: RunConfig["gateStack"]["steps"]): RunConfig => ({
    ghOwner: "acme",
    ghRepo: "app",
    sandboxImage: IMAGE,
    botName: "b",
    botEmail: "b@example.com",
    sandboxHooks: {},
    cwd: repo,
    gateStack: {
      containers: [
        { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
      ],
      steps,
    },
  });

  const podExists = async (): Promise<boolean> =>
    await exec(RUNTIME, ["pod", "exists", podName]).then(
      () => true,
      () => false,
    );

  const podId = async (): Promise<string | null> =>
    await exec(RUNTIME, ["pod", "inspect", podName, "--format", "{{.ID}}"])
      .then((r) => r.stdout.trim())
      .catch(() => null);

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-gate-run-"));
    // Not a git repository, deliberately: the standalone gate skips D1's read
    // rather than merely ignoring its verdict, and `git status` in a
    // non-repository throws rather than shrugging — so this is the case that
    // fails if the read ever comes back.
    await writeFile(join(repo, "marker.txt"), "uncommitted\n");
    podName = podNameFor(gateScope(repo), GATE_STACK_ID);
  }, 60_000);

  afterEach(async () => {
    await exec(RUNTIME, ["pod", "rm", "-f", "-t", "0", podName]).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  }, 120_000);

  it(
    "exits green, then red, and leaves no pod behind either time",
    async () => {
      const out: string[] = [];
      const sink = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };

      const green = await runGateCommand(config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]), { worktree: repo, keep: false, ...sink });
      expect(green).toBe(GATE_EXIT_GREEN);
      // It gated the tree as it stands — uncommitted, and in no repository at
      // all — which is the whole difference from the gate inside a run.
      expect(out.join("")).toContain("uncommitted");
      expect(await podExists()).toBe(false);

      // The SECOND call is the assertion this file exists for: a teardown
      // routed through the process-wide cleanup registry would have run once,
      // here, and left this stack up while still reporting a verdict.
      out.length = 0;
      const red = await runGateCommand(config([
        { name: "boom", in: "runner", command: ["sh", "-c", "echo NOPE >&2; exit 3"] },
      ]), { worktree: repo, keep: false, ...sink });
      expect(red).toBe(GATE_EXIT_RED);
      expect(out.join("")).toContain("NOPE");
      // The step name, so a CI log says which one — and the D9 container logs,
      // which are the only thing never streamed live.
      expect(out.join("")).toContain("boom");
      expect(out.join("")).toContain("--- container runner");
      expect(await podExists()).toBe(false);
    },
    600_000,
  );

  it(
    "keeps a stack when asked, and the next invocation reuses the pod rather than a second one",
    async () => {
      const out: string[] = [];
      const sink = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);

      expect(
        await runGateCommand(cfg, { worktree: repo, keep: true, ...sink }),
      ).toBe(GATE_EXIT_GREEN);
      expect(await podExists()).toBe(true);
      const kept = await podId();
      expect(kept).not.toBeNull();
      // The removal command, because a kept stack is otherwise a pod the
      // operator has no way to name.
      expect(out.join("")).toContain(`pod rm -f ${podName}`);

      // Same config, same tree: the token matches, so the pod is ADOPTED — the
      // SAME pod, not a namesake recreated in its place. The id is what
      // separates those, and what an `ok`-only assertion could not.
      expect(
        await runGateCommand(cfg, { worktree: repo, keep: true, ...sink }),
      ).toBe(GATE_EXIT_GREEN);
      expect(await podId()).toBe(kept);

      // …and `--keep` is opt-in per invocation rather than sticky: the one that
      // does not ask for it takes the stack down, adopted or not.
      expect(
        await runGateCommand(cfg, { worktree: repo, keep: false, ...sink }),
      ).toBe(GATE_EXIT_GREEN);
      expect(await podExists()).toBe(false);
    },
    600_000,
  );

  // Both of these THROW rather than returning a code, and the bin turns a throw
  // on this path into GATE_EXIT_NO_VERDICT — never 0 or 1. That is the whole
  // reason the command has a third code: a stack that could not be brought up
  // reported as a red sends someone to debug a branch that was never gated.
  it(
    "refuses up front when a referenced image is missing, naming the pull",
    async () => {
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);
      const missing = "localhost/sandbar-gate-run-nonexistent:none";
      const err = await runGateCommand(
        {
          ...cfg,
          gateStack: {
            ...cfg.gateStack,
            containers: [
              ...cfg.gateStack.containers,
              { name: "db", image: missing, lifecycle: "issue", hold: true },
            ],
          },
        },
        { worktree: repo, keep: false, out: () => {}, err: () => {} },
      ).then(() => null, (e: unknown) => e);

      // Preflight's rule, re-asked where preflight does not run: sandbar builds
      // what `images` lists and refuses to pull the rest, so the operator gets
      // the command rather than a bringup failure minutes later.
      expect((err as Error | null)?.message).toContain(`pull ${missing}`);
      expect(await podExists()).toBe(false);
    },
    300_000,
  );

  it(
    "throws rather than reddening when an issue container will not come up",
    async () => {
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);
      const err = await runGateCommand(
        {
          ...cfg,
          gateStack: {
            ...cfg.gateStack,
            containers: [
              ...cfg.gateStack.containers,
              {
                name: "db",
                image: IMAGE,
                // D5: an `issue` container depends only on its image and its
                // env, so its failure is infrastructure rather than a verdict.
                lifecycle: "issue",
                hold: true,
                readiness: { kind: "healthcheck", command: ["false"] },
                readinessTimeoutMs: 3_000,
              },
            ],
          },
        },
        { worktree: repo, keep: false, out: () => {}, err: () => {} },
      ).then(() => null, (e: unknown) => e);

      expect((err as Error | null)?.message).toContain("did not become ready");
      // Distinct constants, so a refactor cannot quietly collapse "no verdict"
      // into one of the two codes that IS one.
      expect(GATE_EXIT_NO_VERDICT).not.toBe(GATE_EXIT_RED);
      expect(GATE_EXIT_NO_VERDICT).not.toBe(GATE_EXIT_GREEN);
      // And the half-built stack did not survive the throw.
      expect(await podExists()).toBe(false);
    },
    300_000,
  );
});
