// Gate-stack slice: a stack's test selection (#266) against real podman — the
// `related` pass run in its container with `{changed}` expanded, each step's
// `{tests}` expanded to its share, a step with no share skipped, and a
// `related` that fails or names a file the tree lacks reddening the gate. The
// family header is gate-stack-podman.test-util.ts's.

import { afterAll, describe, it } from "vitest";

import { type GateStackConfig, resolveGateStack } from "./config.js";
import { startStack } from "./gate-stack.js";
import { gateStackFixture, IMAGE } from "./gate-stack-podman.test-util.js";
import { planSelection } from "./gate-selection.js";
import { markExec, retryUndelivered } from "./podman-exec.test-util.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";

const available = podmanTestsEnabled({
  what: "gate-stack selection podman tests",
  image: IMAGE,
});

const { scope: SCOPE, cleanup } = podmanTestScope("gate-stack-selection");

afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

// A marked exec prints this line after its output, so a `related` pass that
// is marked prints it as a path: the tree has it, and no step's tests match it.
const MARKER_FILE = "sandbar-exec-delivered";

const stackWith = (related: readonly string[]) => resolveGateStack({
  containers: [{ name: "runner", image: IMAGE, mountWorktree: "/work", hold: true }],
  steps: [
    {
      name: "test",
      in: "runner",
      command: markExec(["sh", "-c", 'echo "ran:$*"', "sh", "{tests}"]),
      tests: ["*.test.txt"],
    },
    {
      name: "none",
      in: "runner",
      command: ["sh", "-c", "exit 9", "sh", "{tests}"],
      tests: ["nope/**"],
      parallel: true,
    },
  ],
  sanity: ["a.test.txt"],
  related: { in: "runner", command: related },
} satisfies GateStackConfig);

const planFor = (spec: ReturnType<typeof stackWith>) => planSelection({
  declarations: [spec],
  steps: spec.steps,
  changed: [{ path: "x.txt", deleted: false }],
  files: ["a.test.txt", "b.test.txt", "x.txt", MARKER_FILE],
  namedDomains: [],
});

describe.runIf(available)("a gate stack's test selection against real podman", () => {
  it.concurrent(
    "runs related over the changed files, expands each step's share and skips a step with none",
    async ({ expect, task, onTestFinished }) => {
      const { repo, stackId, hold } = await gateStackFixture(SCOPE, task.id, onTestFinished);
      const spec = stackWith(markExec(["sh", "-c", 'printf "%s\\n" b.test.txt "$@"', "sh", "{changed}"]));
      const stack = hold(await startStack({
        stackId, scope: SCOPE, spec, worktreePath: repo, hideWorktreeGit: true,
      }));
      const r = await retryUndelivered(() => stack.runGate(planFor(spec)), (g) => [g.stdout]);

      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("ran:a.test.txt b.test.txt");
      expect(r.stdout).toContain("== none (runner) skipped: no selected test file matches its tests");
      expect(r.steps.map((s) => s.name).slice(-2)).toEqual(["related", "test"]);
      expect(r.selection).toEqual({
        global: ["a.test.txt"],
        core: [],
        domains: {},
        changed: [],
        related: ["b.test.txt", MARKER_FILE, "x.txt"],
        files: ["a.test.txt", "b.test.txt"],
        steps: { test: ["a.test.txt", "b.test.txt"], none: [] },
        ignored: [
          { kind: "unstepped", file: MARKER_FILE },
          { kind: "unstepped", file: "x.txt" },
        ],
      });
    },
    180_000,
  );

  it.concurrent(
    "is red at related when it names a file the tree lacks, or fails",
    async ({ expect, task, onTestFinished }) => {
      const missing = await gateStackFixture(SCOPE, task.id, onTestFinished);
      const failing = await gateStackFixture(SCOPE, `${task.id}-failing`, onTestFinished);
      const missingSpec = stackWith(markExec(["sh", "-c", "echo gone.test.txt", "sh", "{changed}"]));
      const failingSpec = stackWith(["sh", "-c", "exit 3", "sh", "{changed}"]);
      const [missingStack, failingStack] = await Promise.all([
        startStack({
          stackId: missing.stackId, scope: SCOPE, spec: missingSpec,
          worktreePath: missing.repo, hideWorktreeGit: true,
        }).then(missing.hold),
        startStack({
          stackId: failing.stackId, scope: SCOPE, spec: failingSpec,
          worktreePath: failing.repo, hideWorktreeGit: true,
        }).then(failing.hold),
      ]);

      const red = await retryUndelivered(
        () => missingStack.runGate(planFor(missingSpec)),
        (g) => [g.stdout],
      );
      expect(red).toMatchObject({ ok: false, failedStep: "related", exitCode: 1 });
      expect(red.stdout).toContain("not files of the gated tree, so its selection cannot be trusted:\ngone.test.txt");
      expect(red.steps.at(-1)).toMatchObject({ name: "related", ok: false });
      expect(red).not.toHaveProperty("selection");

      const failed = await failingStack.runGate(planFor(failingSpec));
      expect(failed).toMatchObject({ ok: false, failedStep: "related", exitCode: 3 });
      expect(failed.steps.map((s) => s.name)).not.toContain("test");
    },
    180_000,
  );
});
