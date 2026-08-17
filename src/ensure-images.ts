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
import { dirname } from "node:path";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";

import type { BuiltImage, ResolvedGateStack } from "./config.js";
import { SandbarError } from "./errors.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

async function imageExists(tag: string): Promise<boolean> {
  try {
    await exec(RUNTIME, ["image", "exists", tag]);
    return true;
  } catch {
    return false;
  }
}

// The `podman build` argv for one entry. Pure so the stdin-context and
// build-arg wiring is table-testable — the real-adapter blind spot.
export function buildArgv(image: BuiltImage): string[] {
  const args = ["build", "-t", image.tag];
  for (const [k, v] of Object.entries(image.buildArgs ?? {})) {
    args.push("--build-arg", `${k}=${v}`);
  }
  if (image.stdinContext) {
    // The Containerfile arrives on stdin and the context is empty. `-f` would
    // be redundant and podman rejects it alongside the `-` context.
    args.push("-");
  } else {
    args.push("-f", image.containerfile, dirname(image.containerfile));
  }
  return args;
}

async function buildImage(image: BuiltImage): Promise<void> {
  console.log(
    `Building ${image.tag} in ${RUNTIME} (one-time setup; cached afterwards)...`,
  );
  const args = buildArgv(image);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(RUNTIME, args, {
      stdio: [image.stdinContext ? "pipe" : "inherit", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new SandbarError(
              `\`${RUNTIME} ${args.join(" ")}\` exited with code ${code}.`,
            ),
          ),
    );
    if (image.stdinContext && child.stdin) {
      const src = createReadStream(image.containerfile);
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
}

export async function ensureImages(
  images: readonly BuiltImage[],
): Promise<void> {
  for (const image of images) {
    if (!(await imageExists(image.tag))) await buildImage(image);
  }
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
