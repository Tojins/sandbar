// `sandbar gate` — the gate stack, and nothing else (#45).
//
// The gate stack is the one part of sandbar a host repo needs OUTSIDE a sandbar
// run: on a laptop before pushing, and in CI. Until this existed it was
// reachable only THROUGH a run — issue selection, worktrees, agents, the
// single-instance lock — so every consumer wrote a second implementation of it
// in bash against the same `gateStack` literal. The observed one was 219 lines
// with its own readiness loop and, having no pods, its own topology; the shared
// config file then guaranteed the same DESCRIPTION of the stack and not the
// same behaviour, and the gap between the two is where that repo's bugs lived.
//
// So this module is deliberately thin. It is the same `startStack` /
// `runGate` / `stop` the inner loop drives, with the run-shaped scaffolding
// removed and four narrow accommodations, each of which suspends a rule stated
// elsewhere and is therefore argued at its own definition rather than here:
// `allowDirtyWorktree` (D1), `reuseToken` and `keepAlive` (both in
// `gate-stack.ts`'s `StackOptions`), and `ensureImages`' `rebuildInPlace`.
//
// ---------------------------------------------------------------------------
// What it does NOT do, and why each omission is safe
// ---------------------------------------------------------------------------
//   - NO LOCK. `run.lock` exists so two orchestrators cannot drive one workdir;
//     taking it here would make `sandbar gate` refuse to run while a sandbar run
//     is in flight, which is exactly when a developer wants a verdict. Nothing
//     this command touches is shared with a run: the podman resources are in a
//     scope no run computes (`gateScope`), and it writes nothing under
//     `<workDir>` at all — no logs, no state, no branches.
//   - NO `gh`, NO ISSUE RESOLUTION, NO BRANCH MACHINERY. It never reads the
//     tracker and never moves a ref. `resolveConfig` still requires `ghOwner` /
//     `ghRepo` because it is the same function the run uses and the config is
//     one file; that costs a consumer nothing, since a repo with a `gateStack`
//     to run has them already.
//   - NO PREFLIGHT. Preflight is about the repository — the cache, the source
//     branch, the tracker, credentials — and none of it bears on running a
//     stack. The two checks that DO are re-asked here directly: every
//     referenced image sandbar does not build must already be pulled, and D3's
//     root-or-host-uid rule over the worktree-mounting images.
//
// ---------------------------------------------------------------------------
// Concurrency, stated rather than guarded
// ---------------------------------------------------------------------------
// Two `sandbar gate` invocations over the SAME worktree collide: they compute
// one scope (they must, or reuse could not work), so the second force-removes
// the first's pod mid-verdict and the first reports a red that is an artefact.
// That is the bash script's behaviour too, and closing it means a lock, which
// is the thing this command exists to do without. Two invocations over
// DIFFERENT worktrees are disjoint by construction, including a `sandbar gate`
// beside a live `sandbar` run — see `gateScope`.

import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { installCleanupTraps, onCleanup, runCleanup } from "./cleanup.js";
import {
  type ResolvedConfig,
  type ResolvedGateStack,
  type ResolvedStackContainer,
  type RunConfig,
  resolveConfig,
} from "./config.js";
import {
  type BranchImages,
  checkWorktreeImageUids,
  createBranchImages,
  ensureImages,
  pulledImagesOf,
  removeBranchImages,
} from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { summarizeGateFailure } from "./gate.js";
import {
  LOG_READ_TIMEOUT_MS,
  type Stack,
  boundedOk,
  boundedPodman,
  startStack,
} from "./gate-stack.js";
import { dirtyWorktreePaths } from "./git-ops.js";
import { type RunScope, gateScope } from "./naming.js";
import { RUNTIME } from "./runtime.js";
import { sandbarVersion } from "./version.js";

// The standalone gate's stack id. Distinct from every id a run uses — issue
// numbers are numeric and the merge phase's is `merger` — which costs nothing
// (the scope already separates them) and keeps leftover debris readable, which
// is the same reason #47 declined to tokenise the id.
export const GATE_STACK_ID = "gate";

// Exit codes. 0/1 are the shape every test runner and CI system already reads;
// 2 is the one that must not be confused with either, because "the stack could
// not be brought up" is not a verdict about the code and treating it as a red
// sends someone to debug a branch that was never gated.
export const GATE_EXIT_GREEN = 0;
export const GATE_EXIT_RED = 1;
export const GATE_EXIT_NO_VERDICT = 2;

// How much of a red gate's captured step output is recapped after the run.
// Everything was already streamed, so this is a scrollback aid, not the
// diagnosis — but `summarizeGateFailure` leads a timeout cascade with its root
// and its hint, which is precisely the thing a watcher scrolled past.
const RECAP_TAIL_LINES = 60;

export type GateCommandOptions = {
  // The tree to gate. Absolute or relative to the process's cwd; every mount in
  // the stack resolves against it.
  readonly worktree: string;
  // Leave the stack up afterwards, so a red can be poked at — and so the next
  // invocation has something to reuse.
  readonly keep: boolean;
  // Injectable so the reporting can be asserted without a terminal.
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
};

// The reuse token (#45): what a still-running stack has to still be a stack OF
// before this invocation may adopt its `issue`-lifecycle containers.
//
// Pure, and exported, because the whole soundness of the reuse rests on what it
// covers and a hash is not self-describing. It covers exactly the inputs a
// reused container's creation depended on:
//
//   - the `issue` containers' resolved specs. Their image, env, args, mounts,
//     hold, readiness and `postReadyCommands` are what `containerRunArgs` and
//     `bringUpContainers` consumed; change any of them and the container still
//     up is one an older config described. `postReadyCommands` matter most
//     here, since a reused container deliberately does NOT re-run them.
//   - the worktree path, because every relative `mounts` entry resolves against
//     it, so the same spec over a different tree is a different container.
//   - sandbar's own version, because `containerRunArgs` is sandbar's and an
//     upgrade that changes a flag would otherwise silently adopt a container
//     built the old way. The cost is one full rebuild per upgrade.
//
// What it deliberately does NOT cover: the `attempt` containers and the steps.
// Attempt containers are recreated on every gate run by definition, and a step
// is `podman exec`'d into a container it cannot have changed — folding either
// in would tear down a warm database because someone renamed a lint step.
//
// Nor the IMAGES: a reused container may be running a tag the tree has since
// moved, and that question is `runGate`'s existing staleness check, which sees
// what the container is really on (`startStack` reads it back) and recreates
// just that container rather than the whole stack.
export function gateReuseToken(
  spec: ResolvedGateStack,
  worktreePath: string,
  version: string,
): string {
  const issueContainers = spec.containers.filter(
    (c: ResolvedStackContainer) => c.lifecycle === "issue",
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        version,
        worktreePath,
        containers: issueContainers,
      }),
    )
    .digest("hex");
}

// Every referenced image sandbar does not build, that podman does not have.
// The same refusal preflight makes for a run (#24 D7): naming them with the
// `podman pull` line beats a bringup failure minutes later, and pulling on the
// operator's behalf would make a config error into silent network work.
async function missingPulledImages(
  images: readonly string[],
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const image of images) {
    const r = await boundedPodman(["image", "exists", image], LOG_READ_TIMEOUT_MS);
    if (!boundedOk(r)) missing.push(image);
  }
  return missing;
}

// Run the gate stack once over one worktree and return the process exit code.
//
// Returns rather than exits, so the bin owns the exit and the command is
// testable — the same split `run()` declines to make because it owns a run's
// terminal semantics and this owns nothing.
export async function runGateCommand(
  rawConfig: RunConfig,
  opts: GateCommandOptions,
): Promise<number> {
  const out = opts.out ?? ((t: string) => process.stdout.write(t));
  const err = opts.err ?? ((t: string) => process.stderr.write(t));
  const config = resolveConfig(rawConfig);

  const requested = resolve(process.cwd(), opts.worktree);
  if (!existsSync(requested)) {
    throw new SandbarError(
      `No such directory: ${requested}. \`--worktree\` names the tree to gate ` +
        "and defaults to the current directory.",
    );
  }
  // Canonical, for the reason `gateScope` gives: the same tree reached through
  // a symlink must not get a second scope, or `--keep` leaves a stack the next
  // invocation cannot find. It is also what podman gets as every `-v` source.
  const worktreePath = realpathSync(requested);
  const scope = gateScope(worktreePath);

  installCleanupTraps();
  try {
    return await gate(config, opts, { worktreePath, scope, out, err });
  } finally {
    // Every teardown this command owns is an `onCleanup` action — the stack's
    // `stop`, the built images' removal — so the success path, the throw path
    // and the signal path run the identical actions in the identical order.
    // `runCleanup` swallows an action's own failure, so this cannot displace
    // the error it is unwinding.
    await runCleanup();
  }
}

// The body, split out only so the `finally` above wraps every exit from it
// without a `let` for the return value.
async function gate(
  config: ResolvedConfig,
  opts: GateCommandOptions,
  ctx: {
    readonly worktreePath: string;
    readonly scope: RunScope;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  },
): Promise<number> {
  const { worktreePath, scope, out, err } = ctx;

  // First, because everything below is a podman call and the failure otherwise
  // arrives as a raw `spawn podman ENOENT` stack out of whichever call got
  // there first — which for a config whose images sandbar builds is a `podman
  // build`, i.e. an unexplained crash where preflight would have said one
  // sentence. This is preflight's runtime check, re-asked where preflight does
  // not run.
  const probe = await boundedPodman(["--version"], LOG_READ_TIMEOUT_MS);
  if (!boundedOk(probe)) {
    throw new SandbarError(
      `\`${RUNTIME}\` is not usable: \`${RUNTIME} --version\` ` +
        (probe.timedOut
          ? `did not return within ${LOG_READ_TIMEOUT_MS}ms.`
          : `failed (${probe.errorMessage.trim() || "no output"}).`) +
        ` Sandbar runs the gate stack in ${RUNTIME}; install it, or start its ` +
        "service if the client is configured to talk to a remote one.",
    );
  }

  const missing = await missingPulledImages(pulledImagesOf(config));
  if (missing.length > 0) {
    throw new SandbarError(
      `${missing.length} gate-stack image(s) referenced by config.gateStack ` +
        `are missing in ${RUNTIME}. Sandbar builds only what config.images ` +
        `lists and refuses to pull the rest, so pull them:\n` +
        missing.map((i) => `  ${RUNTIME} pull ${i}`).join("\n"),
    );
  }

  // The build context is the tree being gated, which is the only tree this
  // command knows about — and unlike a run, it is deliberately allowed to be
  // dirty, so `rebuildInPlace: false` is what keeps that from rewriting a
  // declared tag some other process is relying on. See `ensureImages`.
  const baseFingerprints = await ensureImages(config.images, worktreePath, {
    rebuildInPlace: false,
  });
  const hostUid = process.getuid?.() ?? 0;
  const branchImages: BranchImages = createBranchImages({
    images: config.images,
    scope,
    baseFingerprints,
    worktreeMountingTags: new Set(
      config.gateStack.containers
        .filter((c) => c.mountWorktree !== null)
        .map((c) => c.image),
    ),
    hostUid,
  });
  onCleanup(async () => {
    const tags = branchImages.builtTags();
    // Not under `--keep`: the containers the operator asked to keep are running
    // these, and `podman rmi -f` on an image in use takes the container with
    // it — which would delete the thing `--keep` exists to preserve.
    if (opts.keep || tags.length === 0) return;
    const failures = await removeBranchImages(tags);
    if (failures.length > 0) {
      err(
        `Could not remove ${failures.length} per-branch image(s) built for ` +
          `this gate run:\n${failures.join("\n")}\n`,
      );
    }
  });

  await checkWorktreeImageUids(config.gateStack, hostUid);

  // Reported, not refused (see `StackOptions.allowDirtyWorktree`). Tolerant of
  // a tree that is not a git worktree at all, because nothing about running a
  // stack requires one.
  const dirty = await dirtyWorktreePaths(worktreePath).catch(() => null);
  if (dirty !== null && dirty.length > 0) {
    out(
      `Gating the WORKING TREE at ${worktreePath}, which has ` +
        `${dirty.length} uncommitted change(s). Inside a run the gate refuses ` +
        "this, because a verdict there is about a commit the merger will " +
        "land; here it is about the tree in front of you.\n",
    );
  }

  // A bringup failure is not a verdict about the code, and it does not need
  // catching to say so: `runGate` converts an `attempt` container's failure to
  // a red before this point, so what can throw here is D5's infra half plus
  // anything unexpected — and the bin turns both into `GATE_EXIT_NO_VERDICT`,
  // never into one of the two codes that IS a verdict.
  const stack: Stack = await startStack({
    stackId: GATE_STACK_ID,
    scope,
    spec: config.gateStack,
    worktreePath,
    images: (only) => branchImages.resolve(worktreePath, only),
    reuseToken: gateReuseToken(
      config.gateStack,
      worktreePath,
      sandbarVersion(),
    ),
    keepAlive: opts.keep,
    allowDirtyWorktree: true,
    onStepOutput: out,
  });

  if (stack.reused.length > 0) {
    out(
      `Reusing ${stack.reused.length} issue-lifecycle container(s) left by a ` +
        `previous \`--keep\` invocation: ${stack.reused.join(", ")}. Their ` +
        "postReadyCommands are not re-run, so whatever they accumulated is " +
        `still in them. Start clean by removing the pod: ${RUNTIME} pod rm -f ` +
        `${stack.podName}\n`,
    );
  }

  const result = await stack.runGate();

  if (result.ok) {
    out("\ngate: GREEN\n");
  } else {
    err(`\ngate: RED — step '${result.failedStep ?? "?"}' (exit ${result.exitCode})\n`);
    // A recap, because everything above was streamed live and the operator has
    // scrolled. `summarizeGateFailure` rather than a raw tail: on a timeout
    // cascade it collapses the wall and leads with the root, which is the one
    // thing a scrollback cannot give back.
    err(`${summarizeGateFailure(`${result.stdout}\n${result.stderr}`, RECAP_TAIL_LINES)}\n`);
    // Never streamed at all — these are the logs of containers no step ran in,
    // which is where a browser failure caused by a 500ing backend is diagnosed
    // (#24 D9).
    if (result.containerLogs) err(`${result.containerLogs}\n`);
  }

  if (opts.keep) {
    out(
      `\nStack left up (\`--keep\`). Inspect it with \`${RUNTIME} pod ps\` / ` +
        `\`${RUNTIME} exec -it <container> sh\`; the next \`sandbar gate\` over ` +
        "this worktree reuses its issue-lifecycle containers. Remove it with: " +
        `${RUNTIME} pod rm -f ${stack.podName} && ${RUNTIME} network rm -f ` +
        `${stack.networkName}\n`,
    );
  }

  return result.ok ? GATE_EXIT_GREEN : GATE_EXIT_RED;
}
