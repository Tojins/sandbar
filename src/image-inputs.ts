// What a built image is a FUNCTION OF, reduced to one hash (#37).
//
// ---------------------------------------------------------------------------
// The bug this exists to close
// ---------------------------------------------------------------------------
// `ensureImages` skips any entry whose TAG already exists, and the tag was the
// only cache key — nothing about the Containerfile's bytes, or about the files
// it COPYs, entered it. The build context is the host checkout, because no
// issue worktree exists yet when the builds run.
//
// So for any gate image that bakes dependencies from a lockfile — the shape #24
// was built to serve, an image carrying `node_modules` or a browser so a gate
// attempt installs nothing — an issue branch that changes that lockfile was
// gated against dependencies built from the SOURCE branch. Both directions are
// silent and both are false verdicts: a branch that adds a dependency reds with
// a module-not-found its author cannot reproduce and can burn the whole attempt
// budget onto `agent-stuck` for a config artefact, and a branch that removes or
// downgrades one greens against a dependency it deleted. Under
// `mergeMode: "verified"` the disagreement surfaces later, as a mysterious red
// on the integration branch after the local gate went green — CI having built
// the same images from the branch under test.
//
// ---------------------------------------------------------------------------
// The shape of the fix
// ---------------------------------------------------------------------------
// The consumer declares what the image is a function of (`rebuildOn`), sandbar
// owns the comparison and the lifecycle — the same split as `mounts` and
// `readiness`. This module is the comparison half: it turns (a root directory,
// an image entry) into a hex fingerprint, and equality of fingerprints is the
// whole decision procedure. `ensure-images.ts` owns what to do about it.
//
// Three things go into the hash, and each was a real way to gate the wrong
// bytes:
//   - the DECLARED PATHS, which is the point;
//   - the CONTAINERFILE's own bytes, because an image is also a function of its
//     recipe and a branch that edits the recipe is exactly as entitled to its
//     own image as one that edits a lockfile;
//   - the BUILD ARGS, which are config rather than branch, but which the
//     tag-only cache also ignored — an operator who changes `AGENT_UID` and
//     re-runs would otherwise keep the image built for the old one.
//
// It deliberately does NOT hash anything else in the context. "Hash the whole
// build context" is the sledgehammer the issue rejects: outdoor's images are
// ~6GB and several minutes, `COPY . .`-style recipes would invalidate on every
// branch, and the tar alone is the cost the baked images were built to avoid.
//
// ---------------------------------------------------------------------------
// Why the encoding is fussy
// ---------------------------------------------------------------------------
// A fingerprint that two different trees can share is a false verdict wearing a
// hash, so the byte stream is unambiguous rather than merely convenient:
//   - declared paths are SORTED, so the fingerprint is a property of the set,
//     not of the order someone wrote it in;
//   - every record carries its own length, so file content cannot be confused
//     with the separators or the path that precedes it;
//   - a directory is walked in sorted order and every entry contributes its
//     relative path, so moving a file between two hashed directories changes
//     the hash;
//   - a SYMLINK contributes its target string, not the bytes it points at. The
//     link is what the build context contains, and following it would hash the
//     same file twice under two names — or leave the root entirely;
//   - an ABSENT path contributes an absence marker rather than nothing, so
//     deleting a declared lockfile is a change and not a no-op.
//
// Files are streamed rather than read whole: a declared input is normally a
// lockfile, but `rebuildOn` accepts a directory and nothing stops a consumer
// pointing it at a large one.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { BuiltImage } from "./config.js";
import { SandbarError } from "./errors.js";

// The image label the fingerprint is recorded under, so a built image carries
// the answer to "what was this built from" and no side-car state file is
// needed. Read back with `podman image inspect --format '{{json .Labels}}'`.
export const IMAGE_INPUTS_LABEL = "sandbar.inputs";

type Hash = ReturnType<typeof createHash>;

// One length-prefixed record. `kind` and `name` are ASCII and go in as-is;
// `body` is arbitrary bytes and is preceded by its length, which is what makes
// the stream unambiguous.
function record(hash: Hash, kind: string, name: string, body: string): void {
  hash.update(`${kind} ${name} ${Buffer.byteLength(body)} `);
  hash.update(body);
}

async function hashFile(
  hash: Hash,
  name: string,
  path: string,
  size: number,
): Promise<void> {
  hash.update(`F ${name} ${size} `);
  // A stream rather than readFile: `rebuildOn` accepts directories, and the
  // whole point of the entry is that its contents may be large.
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
}

// Walks a declared path. `name` is the path RELATIVE to the fingerprint root,
// so the same file under a different name is a different fingerprint.
async function hashPath(
  hash: Hash,
  root: string,
  name: string,
): Promise<void> {
  const absolute = join(root, name);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    // Not an error at this layer: a branch may add or delete a declared input,
    // and both are precisely the change the fingerprint is meant to notice.
    // `ensureImages` is where absence in the HOST checkout is rejected as a
    // typo, because there the path is one the base build already had to COPY.
    record(hash, "absent", name, "");
    return;
  }
  if (stat.isSymbolicLink()) {
    // The link, not its target: it is what the build context contains, and
    // following it either hashes one file under two names or walks out of the
    // root entirely.
    record(hash, "L", name, await readlink(absolute));
    return;
  }
  if (stat.isDirectory()) {
    record(hash, "D", name, "");
    const entries = await readdir(absolute);
    for (const entry of [...entries].sort()) {
      await hashPath(hash, root, `${name}/${entry}`);
    }
    return;
  }
  if (stat.isFile()) {
    await hashFile(hash, name, absolute, stat.size);
    return;
  }
  // A socket, fifo or device node. It has no content a build could copy, but
  // its presence still distinguishes two trees.
  record(hash, "other", name, "");
}

// The fingerprint of one image's declared inputs, rooted at `root`. `null` for
// an image that declares none — it does not participate, and the caller's
// tag-exists check stays its whole cache policy.
//
// `mustExist` is set for the HOST checkout only: there, a declared path that is
// not on disk is a typo, and a typo makes the whole declaration silently inert
// — the exact class of failure #37 is about. Against a gated worktree it is
// left as an absence, because a branch is allowed to delete a lockfile.
export async function fingerprintImageInputs(
  root: string,
  image: BuiltImage,
  opts: { readonly mustExist: boolean },
): Promise<string | null> {
  const paths = image.rebuildOn ?? [];
  if (paths.length === 0) return null;

  const hash = createHash("sha256");
  record(hash, "tag", "", image.tag);

  // The recipe itself. `resolveRebuildOn` has already refused an absolute
  // containerfile alongside `rebuildOn`, so this is inside the root — which is
  // what makes the same call meaningful against a worktree.
  const containerfile = image.containerfile;
  if (isAbsolute(containerfile)) {
    throw new SandbarError(
      `image '${image.tag}': cannot fingerprint an absolute containerfile ` +
        `('${containerfile}') against '${root}'.`,
    );
  }
  await hashPath(hash, root, containerfile);

  for (const [k, v] of Object.entries(image.buildArgs ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    record(hash, "arg", k, v);
  }

  for (const path of [...paths].sort()) {
    if (opts.mustExist) {
      try {
        await lstat(join(root, path));
      } catch {
        throw new SandbarError(
          `config.images: entry '${image.tag}' declares \`rebuildOn\` path ` +
            `'${path}', which does not exist in ${root}. The base image is ` +
            "built from that directory, so a path that isn't there is a typo " +
            "— and an unmatched path would make the whole declaration inert, " +
            "leaving every branch gated against the source branch's " +
            "dependencies.",
        );
      }
    }
    await hashPath(hash, root, path);
  }

  return hash.digest("hex");
}
