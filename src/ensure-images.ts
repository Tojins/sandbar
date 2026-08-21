// Image builds, and the one image property the gate stack cannot discover at
// run time without breaking.
//
// Builds are skipped when the tag already exists, so warm runs pay one
// `image exists` per entry. We shell out to `podman build` directly rather than
// via a sandbox-provider helper, to keep the build context scoped (the upstream
// CLI set context = cwd when given a custom Dockerfile path, which would tar the
// whole repo).
//
// `stdinContext` builds with NO context at all (`podman build -t <tag> - < file`).
// A Containerfile that only pulls from a registry and installs packages needs no
// context, and tarring one up is pure latency.
//
// ---------------------------------------------------------------------------
// Images that are a function of the BRANCH (#37)
// ---------------------------------------------------------------------------
// "The tag already exists" is the whole cache policy only for an image nothing
// in the repo can change. An image that bakes dependencies from a lockfile is a
// function of the branch, and pinning it to the host checkout for the whole run
// makes the gate answer a question about the wrong tree — see image-inputs.ts
// for the failure in full. An entry that says what it is a function of
// (`rebuildOn`) gets a real cache key instead, in two places:
//
//   - `ensureImages` records the fingerprint of the host checkout as an image
//     LABEL and rebuilds when the label no longer matches, so a tag left over
//     from a run before the operator pulled new dependencies is rebuilt rather
//     than reused because its NAME exists;
//   - `createBranchImages` fingerprints each GATED WORKTREE before every gate
//     run. A worktree whose inputs match the base image uses the base image; one
//     that differs gets its own tag, built from that worktree, and gate-stack.ts
//     recreates the stack's containers from it.
//
// Since #46 the AGENT SANDBOX resolves through that same second path — see
// `resolveSandboxImage` at the bottom of this file, which is the same question
// asked for a container that produces no verdict, and therefore has a different
// answer to a build that fails.
//
// `resolve` takes the declared tags its caller will actually RUN, and that
// parameter is required rather than defaulting to "every participating entry".
// The gate and the sandbox share one resolver (they must: a consumer may give
// one image both roles, and the content-addressed tag is then the same build)
// but they do not share a question. A gate run that also resolved the sandbox's
// entry would pay a multi-GB build for an image no container in that stack
// runs, and an `ImageBuildError` from it would red the gate over an image the
// gate never touches.
//
// The per-branch tag is content-addressed (`naming.ts`), so the ordinary
// tag-exists skip is what makes the common cases free: a gate run that changed
// nothing rebuilds nothing, two issues that make the same lockfile change share
// one build, and a rebuild that IS needed still hits podman's layer cache for
// everything above the changed COPY — which is exactly the work CI does.
//
// A build launched from here can fail because of the branch (a lockfile that
// does not install), so `buildImage` can capture its output instead of
// inheriting the console, and reports failure as an `ImageBuildError` carrying
// that output. gate-stack.ts turns one into a red gate: an unbuildable image is
// a verdict about the branch, not an infrastructure fault, and routing it to
// HARD-ERROR would spend two fresh-stack retries reproducing it and then park
// the issue with an "environment" trace.
//
// ---------------------------------------------------------------------------
// The uid check (#24 D3)
// ---------------------------------------------------------------------------
// A container in a pod cannot use `--userns=keep-id` (podman refuses to combine
// it with `--pod`) and cannot be given `--user 1000:1000` meaningfully either:
// inside the pod's default userns that uid maps to a SUBUID, not to the
// invoking user, so its writes to the bind-mounted worktree fail with EACCES.
// Two effective uids work: 0, which rootless podman maps to the invoking user,
// and the host uid itself.
//
// So every image behind a container that declares `mountWorktree` is checked
// before the run starts. The check RUNS the image
// (`podman run --rm --entrypoint id <img> -u`) rather than reading `.Config.User`, because the directive is frequently
// non-numeric (`USER agent`) and an inspect-based check has to either resolve
// /etc/passwd itself or skip — and skipping is precisely the case that then
// fails as a silent EACCES twenty minutes into a gate. One throwaway container
// per image answers it exactly, and preflight already pays comparable costs.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";

import { onCleanup } from "./cleanup.js";
import type { BuiltImage, ResolvedGateStack } from "./config.js";
import type { RuntimeExec, SweepResult } from "./containers.js";
import { SandbarError } from "./errors.js";
import { IMAGE_INPUTS_LABEL, fingerprintImageInputs } from "./image-inputs.js";
import {
  type RunScope,
  isVariantImageTagIn,
  variantImageTag,
} from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// A captured build's output is kept to this many bytes (the TAIL — the error is
// at the end). It reaches a human through a gate-red trace, which is itself
// line-capped downstream; this is only the ceiling on what is held in memory.
export const BUILD_OUTPUT_TAIL_BYTES = 64 * 1024;

// Bound on the podman calls this module makes ABOUT an image rather than to
// build one: `image exists`, `image inspect`, `rmi`.
const IMAGE_QUERY_TIMEOUT_MS = 30_000;

// Default deadline for a build. Generous, because a cold ~6GB image really is
// minutes of legitimate work — but not absent, which is what it was when the
// only builds were base builds running at startup in front of an operator
// watching progress. Since #37 a build also runs INSIDE a gate run, from a
// Containerfile and a lockfile the implementer agent wrote, while the run holds
// the single-instance lock. An unbounded one there is not a slow gate but a run
// that never ends and never tears down — gate-stack.ts's own rule, arriving in
// a second module. `images[].buildTimeoutMs` overrides it per entry, for the
// same reason #26 made the step bound per step: a `FROM alpine` and a 6GB
// browser image do not want the same ceiling and only the consumer knows which
// is which.
export const DEFAULT_BUILD_TIMEOUT_MS = 45 * 60_000;

// Images the gate stack references that sandbar does NOT build. Sandbar refuses
// when one is missing rather than pulling it (#24 D7) — a startup must not do
// silent network work, and a `podman pull` behind the run's lock turns a config
// error into a slow one. Lives here rather than beside either caller because
// since #45 there are two of them (`run.ts`'s preflight and `gate-run.ts`'s),
// and "which images sandbar builds" is one rule.
export function pulledImagesOf(config: {
  readonly images: readonly BuiltImage[];
  readonly gateStack: ResolvedGateStack;
}): readonly string[] {
  const built = new Set(config.images.map((i) => i.tag));
  const referenced = new Set(config.gateStack.containers.map((c) => c.image));
  return [...referenced].filter((i) => !built.has(i));
}

// The images D3's root-or-host-uid rule has to be re-asked about: those a
// worktree-mounting container runs. `createBranchImages` probes a freshly-built
// variant of one of these before any container gets it, because the branch may
// have edited the Containerfile's `USER` and the startup check only ever saw
// the declared images (#37). Beside `pulledImagesOf` and for the same reason:
// two callers since #45, and which images the rule covers is one rule.
export function worktreeMountingTagsOf(
  gateStack: ResolvedGateStack,
): ReadonlySet<string> {
  return new Set(
    gateStack.containers
      .filter((c) => c.mountWorktree !== null)
      .map((c) => c.image),
  );
}

// The baseline recorded for a declared tag whose own provenance is unknown,
// under `ensureImages`' `rebuildInPlace: false` (#45). Not hex, so no
// `fingerprintImageInputs` output can ever equal it, which is the whole
// requirement: it has to compare unequal to every tree so the per-branch
// resolver builds a variant rather than trusting an image nothing vouches for.
const UNKNOWN_PROVENANCE = "unrecorded";

// Builds currently running, so a signal can reap them. ONE cleanup entry for
// the whole process rather than one per build: `onCleanup` never forgets an
// action, and gate-stack.ts declines to register its log followers there for
// exactly that reason.
const liveBuilds = new Set<ChildProcess>();
let buildReaperInstalled = false;

function trackBuild(child: ChildProcess): () => void {
  if (!buildReaperInstalled) {
    buildReaperInstalled = true;
    onCleanup(() => {
      for (const c of liveBuilds) c.kill("SIGKILL");
      liveBuilds.clear();
    });
  }
  liveBuilds.add(child);
  return () => liveBuilds.delete(child);
}

// A `podman build` that failed. Carries the build's own output, because the
// usual cause is the branch's dependencies rather than anything an operator can
// see from the exit code, and gate-stack.ts puts it in the red gate's trace.
export class ImageBuildError extends SandbarError {
  readonly tag: string;
  readonly output: string;
  constructor(tag: string, message: string, output: string) {
    super(output.trim() ? `${message}\n\n${output}` : message);
    this.name = "ImageBuildError";
    this.tag = tag;
    this.output = output;
  }
}

async function imageExists(tag: string): Promise<boolean> {
  try {
    await exec(RUNTIME, ["image", "exists", tag], {
      timeout: IMAGE_QUERY_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// The fingerprint an existing image was built from, or null when the image is
// absent, carries no such label, or podman cannot be asked. Every one of those
// means "cannot prove this image is current", and the caller rebuilds — the
// only safe direction, since the alternative is gating against an image whose
// provenance is unknown.
export async function readInputsLabel(tag: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      RUNTIME,
      ["image", "inspect", tag, "--format", "{{json .Labels}}"],
      { timeout: IMAGE_QUERY_TIMEOUT_MS },
    ));
  } catch {
    return null;
  }
  return parseInputsLabel(stdout);
}

// Pure half of the above, so the shape podman actually prints is table-tested
// rather than assumed. `null` (the literal, for an image with no labels at all)
// and a missing key are the same answer.
export function parseInputsLabel(json: string): string | null {
  const trimmed = json.trim();
  if (!trimmed || trimmed === "null") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[IMAGE_INPUTS_LABEL];
  return typeof value === "string" && value ? value : null;
}

export type BuildOptions = {
  // Directory the containerfile path is resolved against — the host checkout
  // for a base build, the gated worktree for a per-branch one. It is what makes
  // the same `BuiltImage` entry buildable from two different trees.
  readonly root: string;
  // Recorded as an image label so the next run can tell whether this image is
  // still built from the inputs it claims. Null for an entry with no
  // `rebuildOn`, which does not participate.
  readonly fingerprint?: string | null;
  // Capture the build's output instead of inheriting the console. Set for
  // per-branch rebuilds, whose failures are the branch's and have to travel
  // into a gate trace; a base build inherits so a cold multi-minute build shows
  // progress.
  readonly capture?: boolean;
  // Deadline for the whole build. Defaults to DEFAULT_BUILD_TIMEOUT_MS.
  readonly timeoutMs?: number;
};

// The `podman build` argv for one entry. Pure so the stdin-context, build-arg
// and label wiring is table-testable — the real-adapter blind spot.
export function buildArgv(image: BuiltImage, opts?: BuildOptions): string[] {
  const args = ["build", "-t", image.tag];
  for (const [k, v] of Object.entries(image.buildArgs ?? {})) {
    args.push("--build-arg", `${k}=${v}`);
  }
  if (opts?.fingerprint) {
    args.push("--label", `${IMAGE_INPUTS_LABEL}=${opts.fingerprint}`);
  }
  if (image.stdinContext) {
    // The Containerfile arrives on stdin and the context is empty. `-f` would
    // be redundant and podman rejects it alongside the `-` context.
    args.push("-");
  } else {
    const containerfile = containerfilePath(image, opts?.root ?? "");
    args.push("-f", containerfile, dirname(containerfile));
  }
  return args;
}

// Where this entry's containerfile lives when the build is rooted at `root`.
// An absolute path passes through — `resolveRebuildOn` already refuses that
// combination for a `rebuildOn` entry, which is the only case where re-rooting
// has to mean anything.
function containerfilePath(image: BuiltImage, root: string): string {
  return isAbsolute(image.containerfile) || !root
    ? image.containerfile
    : join(root, image.containerfile);
}

// Keeps the last `BUILD_OUTPUT_TAIL_BYTES` of a captured build, and says so
// when it dropped anything — silently truncated output reads as a build that
// simply said little.
function appendTail(tail: string, chunk: string): string {
  const joined = tail + chunk;
  return joined.length <= BUILD_OUTPUT_TAIL_BYTES
    ? joined
    : joined.slice(joined.length - BUILD_OUTPUT_TAIL_BYTES);
}

export async function buildImage(
  image: BuiltImage,
  opts: BuildOptions,
): Promise<string> {
  const args = buildArgv(image, opts);
  const capture = opts.capture ?? true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  let output = "";
  let timedOut = false;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(RUNTIME, args, {
      stdio: [
        image.stdinContext ? "pipe" : "ignore",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    // SIGKILL, and a flag the timer sets rather than anything inferred from an
    // exit code — the same discipline `boundedPodman` uses in gate-stack.ts,
    // for the same reason: a signal a child can report as a clean exit is a
    // bound that cannot fail.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // Tracked for the run's cleanup, because a signal during a build would
    // otherwise leave `podman build` running detached: it finishes minutes
    // after sandbar exited and applies a tag `builtTags()` never saw, so the
    // startup sweep is the only thing that ever reclaims it.
    const untrack = trackBuild(child);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      output = appendTail(output, c);
    });
    child.stderr?.on("data", (c: string) => {
      output = appendTail(output, c);
    });
    child.on("error", (err) => {
      untrack();
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      untrack();
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve();
        return;
      }
      const note = timedOut
        ? `did not finish within ${timeoutMs}ms and was killed. A build that ` +
          "exceeds its bound is a gate red, not an infrastructure failure — " +
          "since #37 the recipe and its inputs are the branch's. Raise " +
          "`images[].buildTimeoutMs` if the build is genuinely this slow."
        : `exited with code ${code}.`;
      reject(
        new ImageBuildError(
          image.tag,
          `\`${RUNTIME} ${args.join(" ")}\` ${note}`,
          output.length === BUILD_OUTPUT_TAIL_BYTES
            ? `[output truncated to the last ${BUILD_OUTPUT_TAIL_BYTES} bytes]\n${output}`
            : output,
        ),
      );
    });
    if (image.stdinContext && child.stdin) {
      const src = createReadStream(
        containerfilePath(image, opts.root),
      );
      src.on("error", (err) => {
        child.kill();
        reject(
          new SandbarError(
            `could not read containerfile '${image.containerfile}' for image ` +
              `'${image.tag}': ${err.message}`,
            { cause: err },
          ),
        );
      });
      // A build that dies before reading its context makes this write EPIPE.
      // With no listener that is an UNCAUGHT exception from inside a promise
      // executor; the exit handler above is the reporting path.
      child.stdin.on("error", () => {});
      src.pipe(child.stdin);
    }
  });
  return output;
}

// Builds every declared image that is missing or stale, and returns the
// fingerprint each participating tag is now built from — the baseline the
// per-branch resolver compares each gated worktree against.
//
// `contextRoot` is `<workDir>/worktrees/source`, detached at
// `origin/<sourceBranch>` (#38) — NOT the operator's checkout, which is what it
// was until the state directory stopped being a checkout at all. The
// fingerprint is a claim about the tree the image was built from, so that tree
// has to be a commit: rooted at `config.cwd` the claim was about whatever the
// operator happened to have in their working tree, uncommitted edits included.
// Passing it explicitly rather than leaning on the process's cwd is the same
// argument one level down — the build and the hash have to be rooted at the
// same place.
//
// `rebuildInPlace: false` is the standalone `sandbar gate` (#45), and it is a
// safety property rather than a speed one. Rewriting a DECLARED tag mutates the
// one podman resource class no scope partitions, and the standalone gate holds
// no lock — so on a host where a `sandbar` run is in flight it would rebuild
// that run's base image from a different tree. That is not a leak but a wrong
// verdict, and a silent one: the run captured its own `baseFingerprints` at
// startup, so a gated worktree whose inputs match that baseline uses the base
// TAG, which by then holds someone else's bytes. With the flag off, a stale
// declared tag is left exactly as it is and the returned baseline is what the
// image RECORDS rather than what the context hashes to — which is the input
// `createBranchImages` needs to route the difference into a scoped, content-
// addressed variant instead. An unlabelled tag (built before sandbar recorded
// inputs, or by hand) contributes no baseline entry and therefore always takes
// the variant path: unknown provenance means rebuild, which is this module's
// rule everywhere else too.
//
// A MISSING tag is still built either way. There is nothing to clobber, and
// refusing would mean `sandbar gate` could not run in CI from a fresh checkout,
// which is most of the point of it existing.
export async function ensureImages(
  images: readonly BuiltImage[],
  contextRoot: string,
  opts?: { readonly rebuildInPlace?: boolean },
): Promise<ReadonlyMap<string, string>> {
  const rebuildInPlace = opts?.rebuildInPlace ?? true;
  const baseFingerprints = new Map<string, string>();
  for (const image of images) {
    const fingerprint = await fingerprintImageInputs(contextRoot, image, {
      mustExist: true,
    });
    if (fingerprint === null) {
      if (!(await imageExists(image.tag))) {
        console.log(
          `Building ${image.tag} in ${RUNTIME} (one-time setup; cached afterwards)...`,
        );
        await buildImage(image, {
          root: contextRoot,
          capture: false,
          timeoutMs: image.buildTimeoutMs,
        });
      }
      continue;
    }
    const recorded = await readInputsLabel(image.tag);
    if (!rebuildInPlace && (await imageExists(image.tag))) {
      // The baseline is what the image on disk was built from, not what this
      // context hashes to — see above. A null recording leaves the entry out,
      // which drops the tag from `participating` in `createBranchImages`… and
      // that is the one place this needs help, because "unknown provenance"
      // would then mean "never rebuild" rather than "always". So it is recorded
      // as a fingerprint no tree can produce.
      baseFingerprints.set(image.tag, recorded ?? UNKNOWN_PROVENANCE);
      continue;
    }
    baseFingerprints.set(image.tag, fingerprint);
    if (recorded === fingerprint) continue;
    console.log(
      recorded === null
        ? `Building ${image.tag} in ${RUNTIME} (declares rebuildOn; not present, or built before sandbar recorded its inputs)...`
        : `Rebuilding ${image.tag} in ${RUNTIME}: its declared inputs in ${contextRoot} changed since it was built...`,
    );
    await buildImage(image, {
      root: contextRoot,
      fingerprint,
      capture: false,
      timeoutMs: image.buildTimeoutMs,
    });
  }
  return baseFingerprints;
}

// ---------------------------------------------------------------------------
// Per-branch images (#37)
// ---------------------------------------------------------------------------

// tag as declared in `gateStack.containers[].image` -> tag to actually run.
// Absent key means "run what was declared"; an empty map is the ordinary case.
export type ImageMap = ReadonlyMap<string, string>;

export type BranchImages = {
  // The images to run over `worktreePath`, building any that are missing.
  //
  // `only` is the set of DECLARED tags the caller is about to run — the gate
  // stack's container images, or the agent sandbox's single image. Required,
  // because the two callers ask about different containers at different moments
  // and a superset is neither free nor harmless: the answer for an entry the
  // caller does not run costs a build it will never use, and a build that fails
  // reaches the caller as an error about an image it never asked for.
  //
  // Called before EVERY gate run, not once per issue: the branch grows under
  // the loop, so an attempt that adds a dependency has to be gated against an
  // image that has it. The sandbox's call is once per sandbox instead — see
  // `resolveSandboxImage`.
  readonly resolve: (
    worktreePath: string,
    only: ReadonlySet<string>,
  ) => Promise<ImageMap>;
  // Every per-branch tag this run built, oldest first. Removed at the end of
  // the run; the layers stay in podman's build cache, so the next run's rebuild
  // of the same inputs is cache hits.
  readonly builtTags: () => readonly string[];
};

export type BranchImagesOptions = {
  readonly images: readonly BuiltImage[];
  readonly scope: RunScope;
  // What `ensureImages` returned: tag -> the fingerprint the base image is
  // built from. A tag absent here does not participate.
  readonly baseFingerprints: ReadonlyMap<string, string>;
  // Injectable for tests, which must be able to exercise the decision (reuse
  // the base image / build a variant / reuse a variant) without podman.
  readonly build?: (image: BuiltImage, opts: BuildOptions) => Promise<unknown>;
  readonly inputsLabel?: (tag: string) => Promise<string | null>;
  readonly log?: (line: string) => void;
  // Declared tags behind a worktree-mounting container, and the host uid they
  // must run as. A freshly-built variant is re-probed against the D3 rule
  // before it is handed to a container (see `checkVariantUid`); an empty set
  // skips it entirely.
  readonly worktreeMountingTags?: ReadonlySet<string>;
  readonly hostUid?: number;
  readonly probeUid?: UidProbe;
};

export function createBranchImages(opts: BranchImagesOptions): BranchImages {
  const build = opts.build ?? buildImage;
  const inputsLabel = opts.inputsLabel ?? readInputsLabel;
  const log = opts.log ?? ((line: string) => console.log(line));
  const worktreeMountingTags = opts.worktreeMountingTags ?? new Set<string>();
  const probeUid = opts.probeUid ?? effectiveUid;
  const participating = opts.images.filter((i) =>
    opts.baseFingerprints.has(i.tag),
  );
  // A build already done or in flight, keyed by the variant tag. Issues in a
  // cycle resolve in parallel, and two branches that make the same lockfile
  // change produce the same content-addressed tag — without this they would
  // race two identical multi-minute builds onto one name.
  const builds = new Map<string, Promise<void>>();
  const order: string[] = [];

  const resolve = async (
    worktreePath: string,
    only: ReadonlySet<string>,
  ): Promise<ImageMap> => {
    const map = new Map<string, string>();
    for (const image of participating) {
      if (!only.has(image.tag)) continue;
      const fingerprint = await fingerprintImageInputs(worktreePath, image, {
        mustExist: false,
      });
      // Non-null by construction: `participating` is exactly the entries that
      // produced a fingerprint against the host checkout, and `rebuildOn` is
      // config rather than anything the branch can change.
      if (fingerprint === null || fingerprint === opts.baseFingerprints.get(image.tag)) {
        continue;
      }
      const tag = variantImageTag(image.tag, opts.scope, fingerprint);
      map.set(image.tag, tag);
      let pending = builds.get(tag);
      if (pending === undefined) {
        const attempt = (async () => {
          // The LABEL, not merely `image exists`. The variant tag carries only
          // the first 8 hex of the fingerprint, so the name alone is a 32-bit
          // cache key, and a leftover tag from a crashed run in this scope is
          // accepted on it. Reading back the full fingerprint the build
          // recorded costs the same one podman call and makes the check the
          // same one the base path already makes — "unknown provenance means
          // rebuild" is this module's own rule.
          if ((await inputsLabel(tag)) !== fingerprint) {
            log(
              `Rebuilding ${image.tag} as ${tag}: ${worktreePath} changed a ` +
                "declared input of it (#37).",
            );
            await build(
              { ...image, tag },
              {
                root: worktreePath,
                fingerprint,
                capture: true,
                timeoutMs: image.buildTimeoutMs,
              },
            );
            // D3, re-asked for an image the BRANCH authored. The Containerfile's
            // own bytes are part of the fingerprint, so a branch is explicitly
            // free to change the recipe — including its `USER` — and the
            // startup check (which runs once, over the declared images) would
            // never see it. Skipping it here is a silent mid-gate EACCES, the
            // one failure D3 exists to convert into a refusal. Asked only for a
            // tag that will actually be mounted onto, and only when it was just
            // built: a reused one was probed when it was.
            if (worktreeMountingTags.has(image.tag)) {
              await checkVariantUid(tag, image.tag, opts.hostUid ?? 0, probeUid);
            }
          }
          // Recorded only once the tag EXISTS, whether this run built it or
          // found it. A tag recorded before the build would send cleanup after
          // an image a failed build never produced, and podman's complaint
          // about the missing tag would be reported as a leak.
          order.push(tag);
        })();
        // A REJECTION is evicted; a success is not. The deduplication exists to
        // stop two parallel issues racing one multi-minute build, and that
        // argument is about work in flight — it is not an argument for caching
        // a failure for the rest of the run.
        //
        // Cached, one transient failure (a registry 5xx on the `FROM` pull,
        // ENOSPC) would be a dead end rather than a bad verdict: the
        // fingerprint stays put as long as the agent does not touch the
        // lockfile again, so every remaining attempt re-throws the SAME stale
        // error, no build is ever retried, and the issue lands on `agent-stuck`
        // with a trace telling its author their dependencies do not install.
        // The merger's gate-2 on a merge result with the same lockfile bytes
        // would inherit it too. Evicting costs a repeated failing build per
        // attempt for a genuinely broken lockfile, bounded by `maxImplAttempts`.
        pending = attempt.catch((err: unknown) => {
          builds.delete(tag);
          throw err;
        });
        builds.set(tag, pending);
      }
      // Awaited even when another worktree started it: the container about to
      // run this tag needs the image to exist, not merely to be on its way. A
      // rejection reaches every waiter that was already queued — correct, since
      // the tag is content-addressed and they asked for the same bytes — while
      // a caller arriving afterwards gets a fresh attempt.
      await pending;
    }
    return map;
  };

  return { resolve, builtTags: () => [...order] };
}

// ---------------------------------------------------------------------------
// The agent sandbox's image (#46)
// ---------------------------------------------------------------------------
// #37 left the sandbox out of the per-branch resolution on the grounds that its
// image "is resolved once, when the sandbox is created, before the branch it
// would be a function of exists". The first half is true and the second is not:
// `inner-loop.ts` prepares the issue worktree BEFORE it creates the sandbox
// (#20, for the stack's mounts), so at that point the branch's files are on
// disk, which is all a fingerprint needs.
//
// What the gap cost is not hypothetical — it is a consumer shell script that
// compares lockfiles against copies kept in the image and re-installs at boot,
// per package manager: image cache invalidation, re-implemented at run time
// because the config could not express it. A stale baked dependency inside the
// sandbox does not produce a false VERDICT (the gate resolves its own images),
// but it reads to the agent as a bug in the code it is being asked to fix.
//
// Two things are deliberately narrower than the gate's version:
//
//   - It resolves ONCE PER SANDBOX, not per attempt. The ralph loop's whole
//     shape is attempts accumulating in one container, so re-resolving mid-issue
//     would mean disposing the sandbox the agent is working in — and the agent
//     can install into its own sandbox with a command, which is a cost of one
//     turn against the certainty of losing its state. What the branch adds
//     during the run still reaches the GATE, per gate run, which is where
//     verdicts come from.
//
//   - A failed build FALLS BACK to the declared tag rather than throwing, and
//     this is the load-bearing half. The sandbox is where the fix gets written:
//     an agent that commits a lockfile which does not install would otherwise
//     make every later sandbox for that branch fail to start — including the
//     ones whose entire purpose is to repair it — and the branch outlives the
//     cycle, so a resumable issue would be wedged rather than merely red. The
//     agent's environment is then one commit stale, which is exactly the
//     pre-#46 state and is recoverable from inside the sandbox.
//
// What that fallback COSTS depends on whether a gate container runs the same
// tag, and the report must not guess. Where it does — sandbar's own config
// gives one image both roles — the gate resolves the entry itself, reds with
// the same build output and blames the branch, so this line is a warning about
// a verdict already on its way. Where the entry is the SANDBOX'S ALONE, which
// is the configuration this feature exists to serve and the one the README's
// example writes, no gate run ever resolves it: `startStack` asks only about
// the images its own spec names. The gate then goes green on images that built
// fine and this line is the only report the failure ever gets. Telling that
// operator to wait for a gate red would send them to watch for something that
// cannot arrive, so `gateRunsSameImage` is a required parameter rather than an
// assumption the message makes on their behalf.
//
// The fallback is reported rather than swallowed: `onFallback` reaches the run
// log and the operator's console at the call site.
export async function resolveSandboxImage(opts: {
  readonly declaredTag: string;
  readonly worktreePath: string;
  // Absent when the run has no per-branch resolver at all (tests, a host that
  // declares no `rebuildOn`) — the declared tag is then the only answer.
  readonly branchImages?: BranchImages | undefined;
  // Does any `gateStack` container run `declaredTag`? It decides what the
  // fallback report can honestly promise, and is required for exactly that
  // reason — see above.
  readonly gateRunsSameImage: boolean;
  readonly onFallback?: (line: string) => void | Promise<void>;
}): Promise<string> {
  const { branchImages, declaredTag, worktreePath } = opts;
  if (!branchImages) return declaredTag;
  try {
    const map = await branchImages.resolve(
      worktreePath,
      new Set([declaredTag]),
    );
    return map.get(declaredTag) ?? declaredTag;
  } catch (err) {
    await opts.onFallback?.(
      `could not build a per-branch agent sandbox image from '${declaredTag}' ` +
        `for ${worktreePath}; starting the sandbox on '${declaredTag}' as ` +
        "declared, which carries the source branch's version of its declared " +
        "inputs. " +
        (opts.gateRunsSameImage
          ? "A gate container runs this same image, so the gate resolves the " +
            "entry itself and will red with this build's output, against the " +
            "branch."
          : "No `gateStack` container runs this image, so nothing else ever " +
            "resolves it: the gate's verdict is computed from images that " +
            "built, and this line is the only report this failure gets.") +
        " The agent's environment is a commit behind its own branch until it " +
        `installs for itself: ${err instanceof Error ? err.message : String(err)}`,
    );
    return declaredTag;
  }
}

// The D3 uid rule applied to a per-branch variant, as an `ImageBuildError` so
// it lands as a gate RED rather than a HARD-ERROR. The blame is the branch's:
// it changed the recipe that changed the uid, and the alternative — two
// fresh-stack retries reproducing an image sandbar itself just built — is the
// misattribution D5 spends a page on.
async function checkVariantUid(
  tag: string,
  declaredTag: string,
  hostUid: number,
  probe: UidProbe,
): Promise<void> {
  let uid: number;
  try {
    uid = await probe(tag);
  } catch (err) {
    throw new ImageBuildError(
      tag,
      `the per-branch image '${tag}' built from this worktree could not be ` +
        `run at all: ${err instanceof Error ? err.message : String(err)}`,
      "",
    );
  }
  if (uid === 0 || uid === hostUid) return;
  throw new ImageBuildError(
    tag,
    `the per-branch image '${tag}' (built from this branch's version of ` +
      `'${declaredTag}') runs as uid ${uid}, which is neither root (0) nor ` +
      `the host uid (${hostUid}). It mounts the worktree, and inside the ` +
      `pod's userns uid ${uid} maps to a subuid rather than to the invoking ` +
      "user, so everything it writes into the tree would fail with EACCES " +
      "mid-gate. This branch changed the image's recipe — drop the `USER` " +
      "directive, or align it to the uid via the entry's `buildArgs`.",
    "",
  );
}

// Best-effort removal of the per-branch tags a run built, returning what could
// not be removed. Teardown, so a failure is reported rather than thrown: it
// leaks an image, which costs disk and nothing else — and `sweepBranchImages`
// reclaims it at the next run of this workdir.
export async function removeBranchImages(
  tags: readonly string[],
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const tag of tags) {
    try {
      await exec(RUNTIME, ["rmi", "-f", tag], {
        timeout: IMAGE_QUERY_TIMEOUT_MS,
      });
    } catch (err) {
      failures.push(
        `  ${RUNTIME} rmi -f ${tag}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return failures;
}

// Per-branch images left behind in THIS scope, swept at startup — the image
// half of `cleanupOrphanContainers`, with the same licence and the same
// asymmetry.
//
// The licence: one lock ⇔ one scope, so a variant tag carrying our scope is
// ours or a dead predecessor's on this workdir, and we hold the lock, so
// nothing in it can be live. Another scope's variants are another workdir's to
// reap and are not touched. Without this the scope segment in the tag would be
// a claim nothing implements: the run-end removal does not run on SIGKILL, a
// hard crash, or a `podman build` that outlived its parent, and these are
// ~6GB-class images that no other code path names.
//
// The asymmetry: a failed LIST throws (a blind sweep would be asserting "no
// debris" on no evidence), a failed REMOVE is collected and reported (it knows
// exactly what leaked, the tag is content-addressed so a leftover is reused
// rather than mistaken for something current, and throwing would let one wedged
// image block every future run).
export async function sweepBranchImages(
  scope: RunScope,
  run: RuntimeExec = (args) => exec(RUNTIME, [...args], {
    timeout: IMAGE_QUERY_TIMEOUT_MS,
  }),
): Promise<SweepResult> {
  const { stdout } = await run([
    "images",
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  const tags = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((t) => isVariantImageTagIn(scope, t));
  const removed: string[] = [];
  const failures: string[] = [];
  for (const tag of tags) {
    const args = ["rmi", "-f", tag];
    try {
      await run(args);
      removed.push(tag);
    } catch (err) {
      failures.push(
        `  ${RUNTIME} ${args.join(" ")}\n    ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { removed, failures };
}

// `--entrypoint id` rather than `run <image> id -u`: with a plain command the
// image's own ENTRYPOINT receives `id -u` as ARGUMENTS, and an entrypoint that
// ignores them (or interprets them) answers a different question than the one
// asked. The whole D3 check rests on this argv, so it is a pure builder that
// can be asserted rather than a literal buried in a call.
export function effectiveUidArgv(image: string): string[] {
  return ["run", "--rm", "--entrypoint", "id", image, "-u"];
}

// Resolves the uid an image runs as. Injectable so the uid RULE can be tested
// without podman — the rule is the part that decides whether a run proceeds.
export type UidProbe = (image: string) => Promise<number>;

// The effective uid an image runs as, resolved by running it. Throws rather
// than guessing: an image that cannot even run `id` is not one the gate can use.
async function effectiveUid(image: string): Promise<number> {
  let stdout: string;
  try {
    // Bounded like every other podman call this module makes. It runs during
    // preflight with the lock held, so a wedged runtime here is a start that
    // never finishes and never releases.
    ({ stdout } = await exec(RUNTIME, effectiveUidArgv(image), {
      timeout: IMAGE_QUERY_TIMEOUT_MS,
    }));
  } catch (err) {
    throw new SandbarError(
      `could not determine the user image '${image}' runs as: ` +
        `\`${RUNTIME} ${effectiveUidArgv(image).join(" ")}\` failed (${
          err instanceof Error ? err.message : String(err)
        }). A container that mounts the worktree must run as root or as the ` +
        "host uid, and sandbar resolves that by running the image.",
      { cause: err },
    );
  }
  const uid = Number(stdout.trim());
  if (!Number.isInteger(uid) || uid < 0) {
    throw new SandbarError(
      `image '${image}' reported a non-numeric uid (${JSON.stringify(
        stdout.trim(),
      )}) from \`id -u\`.`,
    );
  }
  return uid;
}

// Every image behind a worktree-mounting container must run as root or as the
// host uid. Called once per run, after the builds — the images have to exist to
// be probed, and a freshly-built one is exactly the one most likely to be wrong.
export async function checkWorktreeImageUids(
  stack: ResolvedGateStack,
  hostUid: number,
  probe: UidProbe = effectiveUid,
): Promise<void> {
  // Only worktree-mounting containers. Widening this to every image would
  // refuse a perfectly good stack whose mariadb runs as uid 999 and never
  // writes to the tree — a hard, wrong halt on every run. Through the shared
  // `worktreeMountingTagsOf` rather than inline, because `createBranchImages`
  // is handed the same set and the two are one rule: the startup check over
  // the declared images and the per-branch check over what the branch built
  // have to cover the same containers or the second is not the first re-asked.
  const images = worktreeMountingTagsOf(stack);
  for (const image of images) {
    const uid = await probe(image);
    if (uid === 0 || uid === hostUid) continue;
    const names = stack.containers
      .filter((c) => c.mountWorktree !== null && c.image === image)
      .map((c) => `'${c.name}'`)
      .join(", ");
    throw new SandbarError(
      `gate stack: image '${image}' (used by worktree-mounting container(s) ` +
        `${names}) runs as uid ${uid}, which is neither root (0) nor the host ` +
        `uid (${hostUid}).\n\n` +
        "Stack containers run inside a pod, and `--userns=keep-id` cannot be " +
        "combined with `--pod`. Inside the pod's default userns, uid " +
        `${uid} maps to a subuid rather than to you, so everything the ` +
        "container writes into the mounted worktree fails with EACCES — " +
        "mid-gate, as an unexplained permission error.\n\n" +
        "Two fixes: drop the image's `USER` directive so it runs as root " +
        "(rootless podman maps container root to you, and files land owned by " +
        "you), or align the image to your uid at build time — declare the " +
        "image in `config.images` with " +
        "`buildArgs: { AGENT_UID: String(process.getuid?.() ?? 0) }` and have " +
        "its Containerfile `usermod -o -u $AGENT_UID` the user it runs as.",
    );
  }
}
