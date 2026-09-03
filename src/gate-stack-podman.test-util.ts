// Shared fixtures for the gate-stack podman files, and the family's header.
//
// Behaviour PODMAN defines, asserted by running podman — the same argument as
// forge-verify-git.test.ts makes for git. The pure argv builders in
// gate-stack.test.ts prove sandbar emits the flags it means to; they cannot
// prove those flags produce a stack that works, and the facts this family pins
// were all discovered empirically rather than read out of a man page:
//
//   1. a container running as root inside a pod writes files owned by the
//      INVOKING user, which is the only reason dropping `--userns=keep-id`
//      (impossible alongside `--pod`) is survivable
//      — gate-stack-podman.test.ts;
//   2. `podman inspect` reports a REMOVED container with the same exit 125 it
//      gives a podman that is merely unwell, so telling "gone" from "could not
//      answer" needs `container exists` — 0 in any state, 1 for gone (#36)
//      — gate-stack-podman.test.ts;
//   3. an `issue` container keeps its id and its state across gate runs while
//      the `attempt` container gets a new one, which no `ok`-only assertion
//      can see — gate-stack-podman.test.ts.
//
// Podman's own healthcheck quirks are documented in #43 and git history, not
// recurring tests: editing sandbar cannot change them, so they belong to the
// delete-on-red development record rather than every gate run.
//
// Since #48 these files run IN THE GATE, against the host's podman over a
// mounted socket, so those three facts are exercised per attempt rather than
// by a human remembering to. What a remote client cannot pin — the local client's
// signal semantics, and whether podman created a transient systemd timer on the
// HOST — lives in gate-stack-hostpodman.test.ts, which states why.
//
// WHY CONCURRENT TESTS. The expensive waits are spread across six similarly
// sized files, so more shards no longer lower the bound. Each test now runs
// concurrently inside its file. The file-level scope remains the crash reaper;
// a test-specific stack id separates sibling pods and containers, and fixture
// image tags carry their own test token. Setup lives in each test body because
// vitest runs `beforeEach` outside its concurrency limiter. Each callback also
// takes its own `expect` from the test context: the global binding can attach
// assertion counts and snapshots to a concurrent sibling. The file slices:
//
//   gate-stack-podman.test.ts            gate mechanics, the lifecycle split,
//                                        bringup blame (#24 D5/D9, #36), and
//                                        both #50 volume layers
//   gate-stack-health-podman.test.ts     the #49 pre-gate health check, #43
//                                        readiness end to end
//   gate-stack-timeout-podman.test.ts    step timeouts and their reaps (#26),
//                                        sandbar's readiness bound (#43)
//   gate-stack-images-podman.test.ts     per-branch images between gate runs
//                                        (#37, #46)
//   gate-stack-standalone-podman.test.ts the standalone gate's accommodations
//                                        (#45)
//
// Any local image with a shell would do. mariadb is chosen because it serves a
// real listener for the readiness and pod-namespace assertions, and because
// `id -u` in it is 0.
//
// `.test-util.ts` shares `*.test.ts`'s tsconfig exclusion, for the same reason:
// without it this compiles into `dist/` and ships as importable dead weight.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Stack } from "./gate-stack.js";
import { type RunScope, stackContainerNameFor } from "./naming.js";
import {
  type FinishedHook,
  podmanTestStackId,
} from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

export const IMAGE = "docker.io/library/mariadb:10.11";

// Exit code + trimmed stdout of a podman call, for the tests that assert what
// PODMAN answers rather than what sandbar does with the answer.
export const runExit = async (
  args: readonly string[],
): Promise<{ code: number; stdout: string }> => {
  try {
    const { stdout } = await exec(RUNTIME, [...args]);
    return { code: 0, stdout: stdout.trim() };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: (e.stdout ?? "").trim(),
    };
  }
};

// A genuinely DIFFERENT image from `IMAGE`, for the tests about a branch
// changing which image the stack runs.
//
// It was a `podman tag` alias until #45, on the reasoning that the assertion
// is about which image a container was created FROM and an alias answers that
// without paying for a build. It no longer does: the staleness check now
// settles a difference in the reference STRING by comparing image IDs before
// believing it, so re-tagging the identical bytes correctly recreates nothing,
// and an alias would make "a changed image recreates the issue container" a
// test of nothing. One `RUN` layer on an image already on the host is what a
// changed image actually looks like, and is a few seconds.
export const buildVariantImage = async (tag: string): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "sandbar-variant-"));
  try {
    await writeFile(
      join(dir, "Containerfile"),
      `FROM ${IMAGE}\nRUN touch /variant-marker\n`,
    );
    await exec(RUNTIME, [
      "build",
      "-t",
      tag,
      "-f",
      join(dir, "Containerfile"),
      dir,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// The worktree the stack tests gate: one commit, a marker the steps read, and
// an ignored `out/` for the tests that write artifacts without dirtying the
// tree. Each concurrent test registers its own finished hook to remove it.
export const initStackRepo = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), "sandbar-stack-"));
  const git = (...args: string[]) => exec("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");
  await writeFile(join(repo, ".gitignore"), "out/\n");
  await writeFile(join(repo, "marker.txt"), "v1\n");
  await git("add", "-A");
  await git("commit", "-qm", "init");
  return repo;
};

// Per-test state for concurrent gate-stack cases. `hold` both returns the
// stack to the test and registers it for stop-before-worktree cleanup.
export const gateStackFixture = async (
  scope: RunScope,
  taskId: string,
  onTestFinished: FinishedHook,
): Promise<{
  repo: string;
  stackId: string;
  cName: (name: string) => string;
  inspectOf: (name: string, field: string) => Promise<string>;
  idOf: (name: string) => Promise<string>;
  maybeIdOf: (name: string) => Promise<string | null>;
  hold: (stack: Stack) => Stack;
}> => {
  const repo = await initStackRepo();
  const stackId = podmanTestStackId("podmantest", taskId);
  const cName = (name: string): string =>
    stackContainerNameFor(scope, stackId, name);
  const inspectOf = async (name: string, field: string): Promise<string> =>
    (
      await exec(RUNTIME, ["inspect", "--format", field, cName(name)])
    ).stdout.trim();
  const idOf = (name: string): Promise<string> => inspectOf(name, "{{.Id}}");
  const maybeIdOf = (name: string): Promise<string | null> =>
    idOf(name).catch(() => null);
  let held: Stack | null = null;
  onTestFinished(async () => {
    if (held) await held.stop();
    await rm(repo, { recursive: true, force: true });
  }, 120_000);
  return {
    repo,
    stackId,
    cName,
    inspectOf,
    idOf,
    maybeIdOf,
    hold: (stack) => (held = stack),
  };
};
