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
//     stack. The three checks that DO are re-asked here directly: is podman
//     usable at all, is every referenced image sandbar does not build already
//     pulled, and D3's root-or-host-uid rule over the worktree-mounting images.
//   - NO `sandboxHooks`, and this is the omission a consumer will actually
//     trip over, so it is stated rather than left to be discovered.
//     `onWorktreeReady` (a repo's `npm ci`, typically) runs when SANDBAR
//     creates a worktree; here the tree already existed and belongs to the
//     operator. Running it would mean `sandbar gate` reinstalling dependencies
//     in someone's own checkout every invocation — slow, surprising, and a
//     hook whose name is then false. A CI job that starts from a bare checkout
//     therefore runs its own install line before `npx sandbar gate`, which is
//     one line and visible, rather than inheriting one from a field named for
//     a different moment.
//
// ---------------------------------------------------------------------------
// Residuals, recorded rather than discovered
// ---------------------------------------------------------------------------
//   - It DOES install `cleanup.ts`'s traps, which register
//     `uncaughtException`/`unhandledRejection` handlers that `process.exit`.
//     That is the sanctioned route (no module but `cleanup.ts` may trap a
//     signal or exit on one, #35) and `run()` does the same — but it is the one
//     place this command's "returns rather than exits" contract does not reach,
//     so an embedding host inherits an exit on a fault raised somewhere else
//     entirely. Stated because it slightly qualifies "a thin bin can do nothing
//     an embedding host cannot"; not worth a second cleanup mechanism to close.
//   - A stack adopted under `--keep` keeps whatever `attempt` containers the
//     invocation that created it left in the pod. They are recreated by name on
//     every gate run, so a RENAMED one is never recreated and never removed
//     either: the reuse token covers only the `issue` containers, deliberately
//     (see `gateReuseToken`), and nothing sweeps the gate scope, deliberately
//     (there is no lock, so a sweep could not tell debris from a live sibling
//     invocation). Any token change or a `pod rm -f` clears it. It is the one
//     class of debris no report ever names, and it costs a stopped container.
//     Its IMAGES half is the same bullet: `--keep` skips `removeBranchImages`
//     unconditionally, so a kept invocation's content-addressed variants
//     outlive it and nothing sweeps this scope either. Bounded by the number of
//     distinct input states rather than by invocations, and reused by the next
//     gate over the same inputs, which is why it is accepted rather than
//     closed — see the teardown for why the flag, and not "did a stack survive",
//     is what it keys on.
//   - `ensureImages` is handed the GATED WORKTREE as its context root, so
//     `fingerprintImageInputs` runs with `mustExist: true` against a tree that
//     is not necessarily the one the config sits in. That rule is documented
//     one file over as being for the host checkout — a declared `rebuildOn`
//     path missing there is a typo, while a branch is allowed to DELETE a
//     lockfile — and the typo reading is the right one here: this command has
//     exactly one tree, it is the tree the config is about in the default
//     invocation, and an inert declaration silently gating every commit alike
//     is the failure #37 exists to prevent. Under `--worktree <other>` the
//     other reading applies and a deleted input is reported as a typo; the
//     alternative is a gate that goes quietly inert on the tree the operator
//     pointed it at, which is worse in the same direction.
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

import { realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { installCleanupTraps, onCleanup } from "./cleanup.js";
import {
  type BuiltImage,
  type ResolvedConfig,
  type ResolvedGateStack,
  type ResolvedStackContainer,
  type RunConfig,
  resolveConfig,
} from "./config.js";
import {
  type BranchImages,
  ImageBuildError,
  checkWorktreeImageUids,
  createBranchImages,
  ensureImages,
  pulledImagesOf,
  removeBranchImages,
  worktreeMountingTagsOf,
} from "./ensure-images.js";
import { SandbarError, faultDetail } from "./errors.js";
import { summarizeGateFailure } from "./gate.js";
import {
  ContainerBringupError,
  type KeptStack,
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

// The `config.images` entries this command may build: exactly those a
// `gateStack` container runs.
//
// `run.ts` passes `config.images` whole and is right to — a run creates an
// agent sandbox, so the sandbox image is one of the images it runs. This
// command creates no sandbox, and #46 already settled the same question one
// level down when it made `BranchImages.resolve` take the tags its caller runs:
// resolving an entry no container in this stack runs pays for a build nobody
// uses, and lets that build's failure decide a gate the image has nothing to do
// with. `startStack` derives its own `only` set "so no call site can hand the
// shared resolver a superset" — handing `ensureImages` that superset one
// statement earlier is the same mistake with the filter missing rather than
// present.
//
// It is not a nicety on the headline path. The README's own worked config
// declares `localhost/app:sandbar` with its own `rebuildOn` and no gateStack
// container running it; on a cold CI checkout that tag is missing, so
// `ensureImages` would build the whole agent image — the CLI, the toolchain —
// before a single gate container started, and fail the run outright if it did
// not build. This repo cannot notice, because its own config gives one image
// both roles.
//
// `pulledImagesOf` is unaffected and still takes the whole config: the entries
// dropped here are precisely the ones no container references, so they are
// absent from its `referenced` set too and can never be reported as needing a
// pull.
export function gateStackImagesOf(config: {
  readonly images: readonly BuiltImage[];
  readonly gateStack: ResolvedGateStack;
}): readonly BuiltImage[] {
  const run = new Set(config.gateStack.containers.map((c) => c.image));
  return config.images.filter((i) => run.has(i.tag));
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
//
// It returns ALL THREE codes, faults included, and does not throw. That is not
// a stylistic choice about error handling: `GATE_EXIT_NO_VERDICT` is exported
// from the package root beside this function, and a host that took its exit
// code straight off this call — `process.exitCode = await runGateCommand(…)`,
// which is what the bin does, what the README recommends, and what "a thin bin
// can do nothing an embedding host cannot" claims — would get an unhandled
// rejection, or under an ordinary catch-all some code that is not 2, on exactly
// the path the third code exists to make legible. So every fault is rendered
// through the `err` sink under `faultDetail`'s rule (a SandbarError as its
// message, anything else with its stack, so an unexpected bug cannot masquerade
// as a config error) and comes back as the number. The caller loses the error
// OBJECT; `err` is the seam for a host that wants the text somewhere other
// than stderr.
//
// Be precise about which failures are 2, because the two that sound like it
// mostly are not: an image sandbar BUILDS that will not build is a gate RED
// (`failedStep: "image:<tag>"` — the branch authored the recipe and its
// declared inputs), whether it is the cold in-place build of a declared tag or
// #37's per-branch variant, and an `attempt` container that will not come up is
// a gate RED too (D5). What reaches 2 is a config error, an image sandbar does
// not build that is not pulled, an unusable runtime, an `issue`-lifecycle
// container that will not come up, and anything unexpected.
export async function runGateCommand(
  rawConfig: RunConfig,
  opts: GateCommandOptions,
): Promise<number> {
  const out = opts.out ?? ((t: string) => process.stdout.write(t));
  const err = opts.err ?? ((t: string) => process.stderr.write(t));

  installCleanupTraps();
  // The teardown is called DIRECTLY on the way out, and registered with
  // `onCleanup` only so a signal still reaches it. `runCleanup()` would have
  // been shorter and is wrong here: that registry is drained once per PROCESS
  // (#35's own `running` latch never resets), which is right for `run()`, which
  // exits immediately after — and a silent leak for a command that returns a
  // number to a caller who may call it again. So the actions are idempotent and
  // this owns the order; the registry is the signal path, not the normal one.
  const progress: GateProgress = {
    bringupStarted: false,
    stack: null,
    builtTags: null,
  };
  const teardown = teardownFor(opts, err, progress);
  onCleanup(teardown);
  try {
    const config = resolveConfig(rawConfig);
    const requested = resolve(process.cwd(), opts.worktree);
    // A DIRECTORY, not merely a path that exists: every mount resolves against
    // this and podman will happily bind-mount a regular file, so
    // `--worktree ./package.json` would otherwise reach a gate step as a
    // nonsense tree rather than as a complaint.
    if (!statSync(requested, { throwIfNoEntry: false })?.isDirectory()) {
      throw new SandbarError(
        `No such directory: ${requested}. \`--worktree\` names the tree to ` +
          "gate and defaults to the current directory.",
      );
    }
    // Canonical, for the reason `gateScope` gives: the same tree reached
    // through a symlink must not get a second scope, or `--keep` leaves a
    // stack the next invocation cannot find. It is also what podman gets as
    // every `-v` source.
    const worktreePath = realpathSync(requested);
    return await gate(config, opts, {
      worktreePath,
      scope: gateScope(worktreePath),
      out,
      err,
      progress,
    });
  } catch (e) {
    err(`${faultDetail(e)}\n`);
    if (opts.keep) err(keepFaultNotice(progress, e));
    return GATE_EXIT_NO_VERDICT;
  } finally {
    await teardown();
  }
}

// What `--keep` did with the stack, said on the fault path too: an operator who
// asked for something to poke at and is handed only an error must not have to
// work out from the wording which of the cases happened, and a fault is when
// they most want the containers.
//
// FOUR cases, and not one of them can be told from the others by the stack
// handle alone — which is why `bringupStarted` exists and why the error is read
// as well. The handle is null for "no container was ever created" AND for
// "the bringup started and did not finish" AND for "a stack this call only
// ADOPTED is still standing": every throw before `startStack` leaves it null
// (the config validation, the not-a-directory refusal, the runtime probe, the
// missing-pull refusal, a non-`ImageBuildError` out of `ensureImages`, D3's uid
// check), and so does every throw out of `startStack` itself, whether or not
// its teardown kept the pod. A message saying a bringup ran and that the error
// above is what it saw is then false for a config typo and for a `podman pull`
// line, and a message saying nothing was kept is false for the adopted stack —
// which is the class of not-true-on-every-path a message in this repo does not
// get to be.
function keepFaultNotice(progress: GateProgress, cause: unknown): string {
  // Came up, and then something failed — a dead `issue` container caught at the
  // top of the gate run. That stack IS kept, which is sound as well as useful:
  // it is not adoptable while one of its containers is down, and its log is the
  // diagnosis. So it gets the same notice the ordinary exit prints, naming the
  // pod.
  if (progress.stack !== null) return keptStackNotice(progress.stack);
  // Adopted from a previous `--keep` and re-probed by this call, which failed:
  // `startStack` threw, so there is no handle, and its teardown kept the pod
  // anyway because nothing in it is half-built (#45). Only that catch can know
  // this, so it says so on the error rather than leaving it to be guessed here.
  const kept: KeptStack | null =
    cause instanceof ContainerBringupError ? cause.keptStack : null;
  if (kept !== null) {
    return (
      keptStackNotice(kept) +
      // The one thing the ordinary notice cannot be read as promising here.
      // Its first sentence — the next invocation reuses these containers — is
      // still true and is now the problem rather than the point:
      // `containerState` reports a wedged-but-running container as `running`,
      // so it is adopted and re-probed and fails identically, where a stopped
      // one would simply be recreated. Hence the removal line above, and hence
      // saying which of the two an operator is looking at.
      `The failure above is about a container in that stack. If it is still ` +
      `running and merely unhealthy, the next \`sandbar gate\` over this ` +
      `worktree adopts it, re-probes it and fails the same way — fix it in ` +
      `place, or remove the pod to start from a clean one.\n`
    );
  }
  if (progress.bringupStarted) {
    return (
      "The stack was NOT left up despite `--keep`: it never finished coming " +
      "up, and a half-built stack is one the next invocation would adopt as " +
      "if its postReadyCommands had run. The error above is what that " +
      "bringup saw.\n"
    );
  }
  return (
    "No stack was left up despite `--keep`: the failure above happened before " +
    "any container was created, so there was never one to keep.\n"
  );
}

// How far this command got, written by `gate` as each fact becomes true.
// Created before any of them is, because a signal during the bringup has to
// reach whatever DOES exist by then — and read by the two things that must not
// guess: the teardown below, and `keepFaultNotice` above.
type GateProgress = {
  // True from the moment `startStack` is CALLED, so it stays true for a bringup
  // that threw — which is precisely the state `stack` cannot describe, since it
  // is null both for that and for every failure before a container existed.
  bringupStarted: boolean;
  stack: Stack | null;
  builtTags: (() => readonly string[]) | null;
};

// The two things this command has to take down, in the order they have to come
// down in: the stack first, then the images its containers were running.
// Latched, so the `finally` and the signal trap cannot both do it — a second
// `removeBranchImages` over the same tags reports every one of them as a
// failure to remove something that is already gone.
function teardownFor(
  opts: GateCommandOptions,
  err: (text: string) => void,
  progress: GateProgress,
): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    // A teardown failure is reported, never thrown: this runs in a `finally`
    // and from a signal handler, and replacing the verdict — or the error
    // being unwound — with a `pod rm` complaint loses the thing the operator
    // was waiting for. `stop` is idempotent, and a no-op under `--keep` —
    // once the bringup it is keeping actually finished.
    await progress.stack?.stop().catch((e: unknown) => {
      err(`${e instanceof Error ? e.message : String(e)}\n`);
    });
    const tags = progress.builtTags?.() ?? [];
    // Not under `--keep`: the containers the operator asked to keep are
    // running these, and podman's `rmi -f` takes a container using the image
    // with it — which would delete the thing `--keep` exists to preserve.
    //
    // On the flag, not on whether a stack actually survived, even though a
    // bringup that never finished is torn down regardless and leaves nothing
    // running them. `progress.stack` is the only handle on that distinction and
    // it is null for a moment after `startStack` returns, so a signal landing
    // in that window would read "nothing survived" about a stack that is up and
    // kept, and `rmi -f` it out from under the operator. A content-addressed
    // variant left behind costs disk until the next gate over the same inputs
    // reuses it, which is the leak the SIGKILL path already accepts.
    if (opts.keep || tags.length === 0) return;
    const failures = await removeBranchImages(tags);
    if (failures.length > 0) {
      err(
        `Could not remove ${failures.length} per-branch image(s) built for ` +
          `this gate run:\n${failures.join("\n")}\n`,
      );
    }
  };
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
    readonly progress: GateProgress;
  },
): Promise<number> {
  const { worktreePath, scope, out, err, progress } = ctx;

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
  //
  // Over the images this stack RUNS, never `config.images` whole — see
  // `gateStackImagesOf`.
  const gateImages = gateStackImagesOf(config);
  let baseFingerprints: ReadonlyMap<string, string>;
  try {
    baseFingerprints = await ensureImages(gateImages, worktreePath, {
      rebuildInPlace: false,
    });
  } catch (e) {
    // A build that fails is a RED, and it has to be the same red the variant
    // path returns (`failedStep: "image:<tag>"`, #37): the recipe and its
    // declared inputs are files in the tree being gated, so a lockfile that
    // will not install is a fact about that tree rather than about the
    // machine. Uncaught it would unwind to `runGateCommand`'s catch and come
    // back as 2 — so the SAME branch would exit 1 on a warm laptop, where the
    // declared tag exists and only the variant path runs, and 2 on a cold CI
    // checkout, where it does not. The difference is invisible from the
    // operator's side (it is image-cache state, nothing they wrote) and it
    // points CI at its own infrastructure for a build the branch broke, which
    // is the third code's own confusion running backwards.
    //
    // The build itself inherited the console rather than the `out` sink, which
    // is `ensureImages`' own choice and the right one for a cold multi-minute
    // build — so `e.message` here is the failure line and the output it is
    // about is already above it on the terminal.
    if (!(e instanceof ImageBuildError)) throw e;
    err(
      `\ngate: RED — step 'image:${e.tag}'\n` +
        `Refusing to gate: image '${e.tag}' could not be built from ` +
        `${worktreePath}. Sandbar builds it from a Containerfile in the tree ` +
        "being gated, so this is a verdict about that tree and not an " +
        `infrastructure failure.\n${e.message}\n`,
    );
    // Every other exit says what `--keep` did with the stack, and this one is
    // the exit at which an operator most needs to be told there is none: they
    // asked for containers to poke at and got a red, which is exactly the
    // shape that otherwise reads as a teardown bug. No container was created,
    // so `keepFaultNotice` renders that case and no new one is needed.
    if (opts.keep) err(keepFaultNotice(progress, e));
    return GATE_EXIT_RED;
  }
  const hostUid = process.getuid?.() ?? 0;
  const branchImages: BranchImages = createBranchImages({
    images: gateImages,
    scope,
    baseFingerprints,
    worktreeMountingTags: worktreeMountingTagsOf(config.gateStack),
    hostUid,
  });
  progress.builtTags = branchImages.builtTags;

  await checkWorktreeImageUids(config.gateStack, hostUid);

  // Reported, not refused (see `StackOptions.allowDirtyWorktree`).
  //
  // Tolerant of ANY failure to read, not only of a tree that is not a git
  // worktree — which is the commonest one and the reason the read is optional
  // at all, but not the only way `git status` declines to answer: no `git` on
  // the PATH, an unreadable index, a repository whose gitlink points nowhere.
  // The catch is deliberately as wide as that list rather than narrowed to
  // match the sentence above, because what it costs is one informational line
  // and what a narrowed one costs is the opposite trade: matching on git's
  // prose, and a fault exit for a tree the gate could have run against
  // perfectly well.
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
  // catching HERE to say so: `runGate` converts an `attempt` container's
  // failure to a red before this point, so what can throw is D5's infra half
  // plus anything unexpected, and the caller's own catch turns both into
  // `GATE_EXIT_NO_VERDICT` — never into one of the two codes that IS a verdict.
  //
  // Recorded BEFORE the call, not after: from here on a container may exist
  // even if this throws, and that is the state `progress.stack` cannot report
  // and `keepFaultNotice` has to.
  progress.bringupStarted = true;
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
  progress.stack = stack;

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

  if (opts.keep) out(keptStackNotice(stack));

  return result.ok ? GATE_EXIT_GREEN : GATE_EXIT_RED;
}

// What `--keep` left behind, and how to get rid of it. One function because
// the throw path needs it too: a stack that came up and then failed is kept,
// and its pod name is the whole value of having kept it.
//
// It takes the two NAMES rather than a `Stack`, because one of its callers does
// not have one: a stack `startStack` adopted and then threw over is standing,
// and the only thing that reached the caller is the error (#45).
function keptStackNotice(stack: KeptStack): string {
  return (
    `\nStack left up (\`--keep\`). Inspect it with \`${RUNTIME} pod ps\` / ` +
    `\`${RUNTIME} exec -it <container> sh\`; the next \`sandbar gate\` over ` +
    "this worktree reuses its issue-lifecycle containers. Remove it with: " +
    `${RUNTIME} pod rm -f ${stack.podName} && ${RUNTIME} network rm -f ` +
    `${stack.networkName}\n`
  );
}
