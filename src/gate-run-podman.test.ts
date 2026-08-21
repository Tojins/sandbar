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
import {
  gateScope,
  networkNameFor,
  podNameFor,
  stackContainerNameFor,
} from "./naming.js";
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
    // The network too, for the tests that end with a stack still up: `--keep`
    // makes `stop` remove neither, and every test here gets a fresh `mkdtemp`
    // worktree and so a scope no later run computes — debris nothing would
    // ever reclaim.
    await exec(RUNTIME, [
      "network",
      "rm",
      "-f",
      networkNameFor(gateScope(repo), GATE_STACK_ID),
    ]).catch(() => {});
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

  // The case `--keep` exists for, and the one no fake can produce honestly:
  // podman says a container is running while the service inside it is wedged
  // (#45).
  //
  // `broughtUp` used to mean "this call finished a bringup", which is a
  // different fact from "nothing in this pod is half-built" on exactly one
  // path — this one. An ADOPTED stack creates nothing, so a failure in the
  // re-probe that follows destroyed a complete stack: the database and
  // everything its `postReadyCommands` built, at the moment its log was the
  // only diagnosis available. Both halves are asserted, because each fails
  // alone: the pod SURVIVES, and the notice does not claim a half-built
  // bringup — the stack handle is null here exactly as it is for a bringup
  // that never started, so a notice keyed on that alone says both untrue
  // things at once.
  it(
    "keeps an adopted stack whose re-probe fails, and does not call it a half-built bringup",
    async () => {
      const out: string[] = [];
      const sink = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
      const dbName = stackContainerNameFor(gateScope(repo), GATE_STACK_ID, "db");
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);
      // Held, so the container is `sleep infinity` and its own service is
      // nothing but the file the probe reads — which is what lets the test
      // wedge it from outside without killing it. `/tmp`, because `podman
      // exec` enters as the image's user and this one is not root's to write.
      const withDb: RunConfig = {
        ...cfg,
        gateStack: {
          ...cfg.gateStack,
          containers: [
            ...cfg.gateStack.containers,
            {
              name: "db",
              image: IMAGE,
              lifecycle: "issue",
              hold: true,
              readiness: {
                kind: "healthcheck",
                command: ["sh", "-c", "test ! -f /tmp/wedged"],
              },
              readinessTimeoutMs: 5_000,
              // One-shot setup, deliberately not re-run for an adopted
              // container — so this file is what the teardown would have
              // destroyed, and its survival is what the fix is FOR.
              postReadyCommands: [["sh", "-c", "date +%s%N > /tmp/seeded"]],
            },
          ],
        },
      };
      const dbId = async (): Promise<string | null> =>
        await exec(RUNTIME, ["inspect", "--format", "{{.Id}}", dbName])
          .then((r) => r.stdout.trim())
          .catch(() => null);

      expect(
        await runGateCommand(withDb, { worktree: repo, keep: true, ...sink }),
      ).toBe(GATE_EXIT_GREEN);
      const keptPod = await podId();
      const keptDb = await dbId();
      const seeded = (
        await exec(RUNTIME, ["exec", dbName, "cat", "/tmp/seeded"])
      ).stdout.trim();
      expect(keptPod).not.toBeNull();
      expect(seeded).not.toBe("");

      // The service wedges. The container is untouched and podman still calls
      // it `running`, which is precisely why `containerState` cannot tell this
      // from a healthy one and why the adopted container is re-probed at all.
      await exec(RUNTIME, ["exec", dbName, "touch", "/tmp/wedged"]);

      out.length = 0;
      expect(
        await runGateCommand(withDb, { worktree: repo, keep: true, ...sink }),
      ).toBe(GATE_EXIT_NO_VERDICT);

      // Kept: the same pod, the same container, and the state its
      // `postReadyCommands` built still in it. The pod alone would be
      // satisfied by a namesake recreated in its place, and the container id
      // alone says nothing about what is inside it.
      expect(await podId()).toBe(keptPod);
      expect(await dbId()).toBe(keptDb);
      expect(
        (await exec(RUNTIME, ["exec", dbName, "cat", "/tmp/seeded"])).stdout.trim(),
      ).toBe(seeded);

      // …and it is described as what it is. Both negatives are the assertion:
      // each is the sentence a notice reasoning from the null stack handle
      // prints instead, and each is false here.
      expect(out.join("")).toContain("Stack left up");
      expect(out.join("")).toContain(`pod rm -f ${podName}`);
      expect(out.join("")).not.toContain("never finished coming up");
      expect(out.join("")).not.toContain("before any container was created");
      // The wedge is not silent either: an operator told only that the stack
      // is up would go looking for a verdict that was never formed.
      expect(out.join("")).toContain("did not become ready");
    },
    600_000,
  );

  // Both of these RETURN GATE_EXIT_NO_VERDICT rather than throwing, and that
  // is the contract rather than an implementation detail: the constant is
  // exported from the package root beside `runGateCommand`, and the README
  // tells a host to take its exit code straight off the call — so a throw here
  // would be an unhandled rejection on exactly the path the third code exists
  // to make legible. Never 0 or 1 either way: a stack that could not be brought
  // up reported as a red sends someone to debug a branch that was never gated.
  //
  // They are also the two halves of what `--keep` may CLAIM on a fault. Both
  // leave no stack, and for different reasons that the operator has to be able
  // to tell apart: one failed before any container existed, the other left a
  // half-built stack that had to be destroyed rather than kept.
  it(
    "refuses up front when a referenced image is missing, naming the pull",
    async () => {
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);
      const missing = "localhost/sandbar-gate-run-nonexistent:none";
      const out: string[] = [];
      const code = await runGateCommand(
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
        // `--keep`, so the notice below is reached: this refusal happens
        // before a single container exists.
        {
          worktree: repo,
          keep: true,
          out: (t) => out.push(t),
          err: (t) => out.push(t),
        },
      );

      expect(code).toBe(GATE_EXIT_NO_VERDICT);
      // Preflight's rule, re-asked where preflight does not run: sandbar builds
      // what `images` lists and refuses to pull the rest, so the operator gets
      // the command rather than a bringup failure minutes later — and gets it
      // through the sink, since returning the code means nothing else prints
      // it.
      expect(out.join("")).toContain(`pull ${missing}`);
      // And the `--keep` notice tells the truth about THIS path. A stack
      // handle is null here exactly as it is for a bringup that started and
      // threw, so a notice keyed on it alone says a bringup ran and that the
      // error above is what it saw — for a `podman pull` line. The negative is
      // the assertion that fails if the two collapse back into one.
      expect(out.join("")).toContain("before any container was created");
      expect(out.join("")).not.toContain("never finished coming up");
      expect(await podExists()).toBe(false);
    },
    300_000,
  );

  it(
    "reports no verdict rather than a red when an issue container will not come up, and does not keep the wreckage",
    async () => {
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);
      const out: string[] = [];
      const code = await runGateCommand(
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
        // `--keep`, deliberately: this is the combination that must not stand.
        // A kept half-built stack carries a pod label the next invocation of
        // the same config matches, and its `issue` container is `running` and
        // healthy — so it would be adopted, its postReadyCommands would not be
        // re-run because they never ran, and the gate would form a verdict
        // against a database whose declared setup does not exist.
        {
          worktree: repo,
          keep: true,
          out: (t) => out.push(t),
          err: (t) => out.push(t),
        },
      );

      expect(code).toBe(GATE_EXIT_NO_VERDICT);
      // Distinct constants, so a refactor cannot quietly collapse "no verdict"
      // into one of the two codes that IS one.
      expect(GATE_EXIT_NO_VERDICT).not.toBe(GATE_EXIT_RED);
      expect(GATE_EXIT_NO_VERDICT).not.toBe(GATE_EXIT_GREEN);
      expect(out.join("")).toContain("did not become ready");
      // Torn down despite the flag, and SAID so — an operator who asked for a
      // stack to poke at and finds none must not be left guessing whether the
      // teardown or the bringup is what went wrong.
      expect(await podExists()).toBe(false);
      expect(out.join("")).toContain("NOT left up");
      // The other half of the pair above: HERE a bringup really did start and
      // fail, so this is the one path on which that sentence is true — and it
      // must not be the sentence the pre-container refusal gets.
      expect(out.join("")).toContain("never finished coming up");
      expect(out.join("")).not.toContain("before any container was created");
    },
    300_000,
  );

  // Which declared images this command builds, and what a build failure in one
  // MEANS. Both are about `config.images` entries and neither is visible from a
  // config that gives one image both roles — which is what this repo's own does,
  // and why they are asserted here against podman rather than argued.
  const BROKEN_CONTAINERFILE = `FROM ${IMAGE}\nRUN exit 7\n`;
  const SANDBOX_ONLY_TAG = "localhost/sandbar-gate-run-sandbox:none";
  const rmi = async (tag: string): Promise<void> => {
    await exec(RUNTIME, ["rmi", "-f", tag]).catch(() => {});
  };
  const imageExists = async (tag: string): Promise<boolean> =>
    await exec(RUNTIME, ["image", "exists", tag]).then(
      () => true,
      () => false,
    );

  it(
    "does not build a declared image no gateStack container runs",
    async () => {
      await rmi(SANDBOX_ONLY_TAG);
      await writeFile(join(repo, "Containerfile.broken"), BROKEN_CONTAINERFILE);
      const out: string[] = [];
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);
      const code = await runGateCommand(
        {
          ...cfg,
          // Every consumer's `config.images` carries this entry —
          // `resolveImages` requires one for `sandboxImage` — and in the
          // configuration this feature exists to serve (the README's own), no
          // gateStack container runs it. Missing, and unbuildable: so a command
          // that built it would fail here, and one that merely built it would
          // pay for the whole agent image before the first gate container on
          // every cold CI checkout.
          sandboxImage: SANDBOX_ONLY_TAG,
          images: [
            { tag: SANDBOX_ONLY_TAG, containerfile: "Containerfile.broken" },
          ],
        },
        {
          worktree: repo,
          keep: false,
          out: (t) => out.push(t),
          err: (t) => out.push(t),
        },
      );

      expect(code).toBe(GATE_EXIT_GREEN);
      // Not merely "it did not fail": the tag is still absent, so the build was
      // never attempted rather than attempted and forgiven.
      expect(await imageExists(SANDBOX_ONLY_TAG)).toBe(false);
      expect(await podExists()).toBe(false);
    },
    600_000,
  );

  it(
    "reds — not 2 — when an image the stack DOES run will not build",
    async () => {
      await rmi(SANDBOX_ONLY_TAG);
      await writeFile(join(repo, "Containerfile.broken"), BROKEN_CONTAINERFILE);
      const out: string[] = [];
      const cfg = config([
        { name: "read", in: "runner", command: ["cat", "marker.txt"] },
      ]);
      const code = await runGateCommand(
        {
          ...cfg,
          sandboxImage: SANDBOX_ONLY_TAG,
          images: [
            { tag: SANDBOX_ONLY_TAG, containerfile: "Containerfile.broken" },
          ],
          gateStack: {
            ...cfg.gateStack,
            containers: [
              {
                name: "runner",
                image: SANDBOX_ONLY_TAG,
                mountWorktree: "/work",
                hold: true,
              },
            ],
          },
        },
        // `--keep`, so the notice is reached: a red is exactly when an
        // operator wants the containers, and this red happens before any
        // container exists.
        {
          worktree: repo,
          keep: true,
          out: (t) => out.push(t),
          err: (t) => out.push(t),
        },
      );

      // The recipe and its inputs are files in the tree being gated, so this is
      // a verdict about that tree. Left to unwind it would be a 2, and the SAME
      // branch would then exit 1 on a warm laptop — where the tag exists and
      // only #37's variant path runs — and 2 on a cold CI checkout, on a
      // difference the operator cannot see.
      expect(code).toBe(GATE_EXIT_RED);
      expect(code).not.toBe(GATE_EXIT_NO_VERDICT);
      // Named the way the variant path names it, so a CI log reads the same
      // either way.
      expect(out.join("")).toContain(`image:${SANDBOX_ONLY_TAG}`);
      // …and it says what `--keep` did, which every other exit does: a red
      // with no stack behind it and nothing said about why reads as a teardown
      // bug. This is the pre-container case, not the half-built one.
      expect(out.join("")).toContain("before any container was created");
      expect(out.join("")).not.toContain("never finished coming up");
      expect(await podExists()).toBe(false);
    },
    600_000,
  );
});
