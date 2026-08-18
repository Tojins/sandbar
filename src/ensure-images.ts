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

import { execFile, spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";

import type { BuiltImage, ResolvedGateStack } from "./config.js";
import { SandbarError } from "./errors.js";
import { IMAGE_INPUTS_LABEL, fingerprintImageInputs } from "./image-inputs.js";
import { type RunScope, variantImageTag } from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// A captured build's output is kept to this many bytes (the TAIL — the error is
// at the end). It reaches a human through a gate-red trace, which is itself
// line-capped downstream; this is only the ceiling on what is held in memory.
export const BUILD_OUTPUT_TAIL_BYTES = 64 * 1024;

// Bound on the podman calls this module makes ABOUT an image rather than to
// build one: `image exists`, `image inspect`, `rmi`. Builds themselves are
// deliberately unbounded — a cold ~6GB image is minutes of legitimate work and
// there is no honest number to pick.
const IMAGE_QUERY_TIMEOUT_MS = 30_000;

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
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(RUNTIME, args, {
      stdio: [
        image.stdinContext ? "pipe" : "ignore",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      output = appendTail(output, c);
    });
    child.stderr?.on("data", (c: string) => {
      output = appendTail(output, c);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new ImageBuildError(
              image.tag,
              `\`${RUNTIME} ${args.join(" ")}\` exited with code ${code}.`,
              output.length === BUILD_OUTPUT_TAIL_BYTES
                ? `[output truncated to the last ${BUILD_OUTPUT_TAIL_BYTES} bytes]\n${output}`
                : output,
            ),
          ),
    );
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
// `contextRoot` is the host checkout (`config.cwd`). Passing it explicitly
// rather than leaning on the process's cwd is not cosmetic: the fingerprint is
// a claim about the tree the image was built from, so the build and the hash
// have to be rooted at the same place, and a consumer that sets `config.cwd`
// away from the process cwd previously built from one and would have hashed the
// other.
export async function ensureImages(
  images: readonly BuiltImage[],
  contextRoot: string,
): Promise<ReadonlyMap<string, string>> {
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
        await buildImage(image, { root: contextRoot, capture: false });
      }
      continue;
    }
    baseFingerprints.set(image.tag, fingerprint);
    const recorded = await readInputsLabel(image.tag);
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
  // The images to run for a gate of `worktreePath`, building any that are
  // missing. Called before EVERY gate run, not once per issue: the branch grows
  // under the loop, so an attempt that adds a dependency has to be gated
  // against an image that has it.
  readonly resolve: (worktreePath: string) => Promise<ImageMap>;
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
  readonly exists?: (tag: string) => Promise<boolean>;
  readonly log?: (line: string) => void;
};

export function createBranchImages(opts: BranchImagesOptions): BranchImages {
  const build = opts.build ?? buildImage;
  const exists = opts.exists ?? imageExists;
  const log = opts.log ?? ((line: string) => console.log(line));
  const participating = opts.images.filter((i) =>
    opts.baseFingerprints.has(i.tag),
  );
  // A build already done or in flight, keyed by the variant tag. Issues in a
  // cycle resolve in parallel, and two branches that make the same lockfile
  // change produce the same content-addressed tag — without this they would
  // race two identical multi-minute builds onto one name.
  const builds = new Map<string, Promise<void>>();
  const order: string[] = [];

  const resolve = async (worktreePath: string): Promise<ImageMap> => {
    const map = new Map<string, string>();
    for (const image of participating) {
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
        pending = (async () => {
          if (!(await exists(tag))) {
            log(
              `Rebuilding ${image.tag} as ${tag}: ${worktreePath} changed a ` +
                "declared input of it (#37).",
            );
            await build(
              { ...image, tag },
              { root: worktreePath, fingerprint, capture: true },
            );
          }
          // Recorded only once the tag EXISTS, whether this run built it or
          // found it. A tag recorded before the build would send cleanup after
          // an image a failed build never produced, and podman's complaint
          // about the missing tag would be reported as a leak.
          order.push(tag);
        })();
        builds.set(tag, pending);
      }
      // Awaited even when another worktree started it: the container about to
      // run this tag needs the image to exist, not merely to be on its way.
      // A rejection is re-thrown to every waiter, which is correct — the tag is
      // content-addressed, so a build that failed for one worktree fails for
      // every worktree that asked for the same bytes.
      await pending;
    }
    return map;
  };

  return { resolve, builtTags: () => [...order] };
}

// Best-effort removal of the per-branch tags a run built, returning what could
// not be removed. Teardown, so a failure is reported rather than thrown: it
// leaks an image, which costs disk and nothing else — the tag is
// content-addressed and scoped, so a leftover is reused rather than mistaken
// for something current.
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
    ({ stdout } = await exec(RUNTIME, effectiveUidArgv(image)));
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
  // writes to the tree — a hard, wrong halt on every run.
  const images = new Set(
    stack.containers.filter((c) => c.mountWorktree !== null).map((c) => c.image),
  );
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
