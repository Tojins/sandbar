// #37 — a gate image that bakes dependencies is a function of the BRANCH, and
// the tag alone was the whole cache key.
//
// Everything here is about one question: does the fingerprint change exactly
// when the image would have to be rebuilt? A fingerprint two different trees
// can share is a false gate verdict wearing a hash, so the collision cases are
// asserted directly rather than trusted to the encoding's comments — the
// naive-concatenation collisions below are constructible by hand, which is why
// the encoding length-prefixes every record.

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { BuiltImage } from "./config.js";
import {
  type BuildOptions,
  createBranchImages,
  parseInputsLabel,
} from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { fingerprintImageInputs } from "./image-inputs.js";
import { type RunScope, runScope, variantImageTag } from "./naming.js";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

// A tree on disk. `files` maps relative path -> contents; directories are
// created as needed.
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandbar-image-inputs-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const IMAGE: BuiltImage = {
  tag: "app",
  containerfile: "Containerfile",
  rebuildOn: ["package-lock.json"],
};

function fp(root: string, image: BuiltImage = IMAGE): Promise<string | null> {
  return fingerprintImageInputs(root, image, { mustExist: false });
}

describe("fingerprintImageInputs", () => {
  it("is null for an image that declares no inputs — it does not participate", async () => {
    const root = await tree({ Containerfile: "FROM x" });
    expect(await fp(root, { tag: "app", containerfile: "Containerfile" })).toBe(
      null,
    );
  });

  it("is stable for the same bytes and differs for changed ones", async () => {
    const a = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const b = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const c = await tree({
      Containerfile: "FROM x",
      "package-lock.json": '{"a":1}',
    });
    expect(await fp(a)).toBe(await fp(b));
    expect(await fp(a)).not.toBe(await fp(c));
  });

  it("covers the CONTAINERFILE's own bytes — an image is a function of its recipe", async () => {
    const a = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const b = await tree({
      Containerfile: "FROM x\nRUN npm ci",
      "package-lock.json": "{}",
    });
    expect(await fp(a)).not.toBe(await fp(b));
  });

  it("covers buildArgs — config the tag-only cache also ignored", async () => {
    const root = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const withUid = { ...IMAGE, buildArgs: { AGENT_UID: "1000" } };
    const other = { ...IMAGE, buildArgs: { AGENT_UID: "1001" } };
    expect(await fp(root, withUid)).not.toBe(await fp(root, other));
    expect(await fp(root, withUid)).not.toBe(await fp(root));
  });

  it("does not depend on the ORDER the inputs were declared in", async () => {
    const root = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "{}",
      "bower.json": "{}",
    });
    const one = { ...IMAGE, rebuildOn: ["package-lock.json", "bower.json"] };
    const two = { ...IMAGE, rebuildOn: ["bower.json", "package-lock.json"] };
    expect(await fp(root, one)).toBe(await fp(root, two));
  });

  it("treats an ABSENT input as a change, not as a no-op", async () => {
    const present = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "",
    });
    const absent = await tree({ Containerfile: "FROM x" });
    // An empty file and a missing file are the tempting collision: both
    // contribute no content.
    expect(await fp(present)).not.toBe(await fp(absent));
    const alsoAbsent = await tree({ Containerfile: "FROM x" });
    expect(await fp(absent)).toBe(await fp(alsoAbsent));
  });

  it("distinguishes two trees a naive concatenation would collide", async () => {
    // Without length prefixes, `a` holding "b" + `b` holding "" and `a` holding
    // "" + `b` holding "b" stream the same bytes.
    const image = { ...IMAGE, rebuildOn: ["a", "b"] };
    const left = await tree({ Containerfile: "FROM x", a: "b", b: "" });
    const right = await tree({ Containerfile: "FROM x", a: "", b: "b" });
    expect(await fp(left, image)).not.toBe(await fp(right, image));
  });

  it("walks a declared DIRECTORY, and notices a file moving between two of them", async () => {
    const image = { ...IMAGE, rebuildOn: ["patches", "vendor"] };
    const base = await tree({
      Containerfile: "FROM x",
      "patches/one.diff": "x",
      "vendor/keep": "y",
    });
    const added = await tree({
      Containerfile: "FROM x",
      "patches/one.diff": "x",
      "patches/two.diff": "z",
      "vendor/keep": "y",
    });
    const moved = await tree({
      Containerfile: "FROM x",
      "vendor/one.diff": "x",
      "vendor/keep": "y",
    });
    expect(await fp(base, image)).not.toBe(await fp(added, image));
    // The bytes hashed are identical; only the names differ. A walk that hashed
    // content alone would call these the same tree.
    expect(await fp(base, image)).not.toBe(await fp(moved, image));
  });

  it("hashes a SYMLINK's target, not the file it points at", async () => {
    const linked = await tree({ Containerfile: "FROM x", real: "contents" });
    await symlink("real", join(linked, "package-lock.json"));
    const copied = await tree({
      Containerfile: "FROM x",
      real: "contents",
      "package-lock.json": "contents",
    });
    expect(await fp(linked)).not.toBe(await fp(copied));
  });

  it("throws for a declared path missing from the HOST checkout — a typo makes the whole declaration inert", async () => {
    const root = await tree({ Containerfile: "FROM x" });
    await expect(
      fingerprintImageInputs(root, IMAGE, { mustExist: true }),
    ).rejects.toBeInstanceOf(SandbarError);
    // The same absence against a gated worktree is data: a branch is allowed to
    // delete a lockfile.
    await expect(
      fingerprintImageInputs(root, IMAGE, { mustExist: false }),
    ).resolves.toEqual(expect.any(String));
  });
});

describe("parseInputsLabel", () => {
  it("reads the label podman prints", () => {
    expect(
      parseInputsLabel('{"io.buildah.version":"1.33.7","sandbar.inputs":"abc"}'),
    ).toBe("abc");
  });

  it("is null for an image with no labels, no such label, or unparseable output", () => {
    // Every one of these means "cannot prove this image is current", and the
    // caller rebuilds — the only safe direction.
    expect(parseInputsLabel("null")).toBe(null);
    expect(parseInputsLabel("")).toBe(null);
    expect(parseInputsLabel("{}")).toBe(null);
    expect(parseInputsLabel('{"other":"x"}')).toBe(null);
    expect(parseInputsLabel("not json")).toBe(null);
    expect(parseInputsLabel('{"sandbar.inputs":""}')).toBe(null);
  });
});

describe("variantImageTag", () => {
  const scope = runScope("/repo") as RunScope;

  it("appends to the TAG component, never inventing a repository", () => {
    expect(variantImageTag("sandbar-outdoor", scope, "9f2e1d70ab")).toBe(
      `sandbar-outdoor:sb-${scope}-9f2e1d70`,
    );
    expect(variantImageTag("sandbar-outdoor:latest", scope, "9f2e1d70ab")).toBe(
      `sandbar-outdoor:latest-sb-${scope}-9f2e1d70`,
    );
    expect(variantImageTag("localhost/x/y:v1", scope, "9f2e1d70ab")).toBe(
      `localhost/x/y:v1-sb-${scope}-9f2e1d70`,
    );
  });

  it("does not mistake a registry PORT for a tag", () => {
    // `registry.example:5000/x` is untagged; appending to it would name a
    // different registry rather than a different tag.
    expect(variantImageTag("registry.example:5000/x", scope, "abcdef01")).toBe(
      `registry.example:5000/x:sb-${scope}-abcdef01`,
    );
  });

  it("stays inside podman's 128-char tag limit for a realistic base tag", () => {
    const tag = variantImageTag("sandbar-outdoor:latest", scope, "9f2e1d70ab");
    expect(tag.slice(tag.lastIndexOf(":") + 1).length).toBeLessThan(128);
  });
});

describe("createBranchImages", () => {
  const scope = runScope("/repo") as RunScope;

  // A resolver over a fake podman: `built` records what was actually built, so
  // the reuse/rebuild decision is asserted rather than the argv.
  function harness(images: readonly BuiltImage[], base: Map<string, string>) {
    const built: { tag: string; root: string }[] = [];
    const present = new Set<string>();
    const branchImages = createBranchImages({
      images,
      scope,
      baseFingerprints: base,
      exists: async (tag) => present.has(tag),
      build: async (image: BuiltImage, opts: BuildOptions) => {
        built.push({ tag: image.tag, root: opts.root });
        present.add(image.tag);
      },
      log: () => {},
    });
    return { branchImages, built, present };
  }

  it("maps nothing and builds nothing when the worktree matches the base image", async () => {
    const root = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const base = new Map([["app", (await fp(root))!]]);
    const { branchImages, built } = harness([IMAGE], base);
    expect((await branchImages.resolve(root)).size).toBe(0);
    expect(built).toEqual([]);
    expect(branchImages.builtTags()).toEqual([]);
  });

  it("builds a per-branch image FROM THAT WORKTREE when a declared input changed", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({
      Containerfile: "FROM x",
      "package-lock.json": '{"added":"dep"}',
    });
    const base = new Map([["app", (await fp(source))!]]);
    const { branchImages, built } = harness([IMAGE], base);

    const map = await branchImages.resolve(branch);
    const variant = variantImageTag("app", scope, (await fp(branch))!);
    expect(map.get("app")).toBe(variant);
    // Rooted at the branch's worktree — building it from the host checkout
    // would answer the same wrong question the whole feature exists to stop.
    expect(built).toEqual([{ tag: variant, root: branch }]);
  });

  it("is content-addressed: two worktrees with the same change share one build", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const one = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const two = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    const { branchImages, built } = harness([IMAGE], base);

    // Concurrently, as the issues in a cycle resolve: without in-flight
    // deduplication both would race the same multi-minute build onto one name.
    const [a, b] = await Promise.all([
      branchImages.resolve(one),
      branchImages.resolve(two),
    ]);
    expect(a.get("app")).toBe(b.get("app"));
    expect(built).toHaveLength(1);
  });

  it("re-resolves per call, so a worktree that changes MID-CYCLE gets a new image", async () => {
    // The reachable shape of the bug: attempt 1 adds a dependency, and gate-1
    // for that same issue must not run the image the stack started with.
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const base = new Map([["app", (await fp(source))!]]);
    const { branchImages, built } = harness([IMAGE], base);

    expect((await branchImages.resolve(branch)).size).toBe(0);
    await writeFile(join(branch, "package-lock.json"), '{"added":"dep"}');
    expect((await branchImages.resolve(branch)).get("app")).toBe(
      variantImageTag("app", scope, (await fp(branch))!),
    );
    expect(built).toHaveLength(1);
  });

  it("reuses an existing variant tag rather than rebuilding it", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    const { branchImages, built, present } = harness([IMAGE], base);
    present.add(variantImageTag("app", scope, (await fp(branch))!));

    expect((await branchImages.resolve(branch)).size).toBe(1);
    expect(built).toEqual([]);
    // Still reported as this run's, so cleanup reaches it.
    expect(branchImages.builtTags()).toHaveLength(1);
  });

  it("ignores images that declare no inputs", async () => {
    const root = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const plain: BuiltImage = { tag: "sandbox", containerfile: "Containerfile" };
    const { branchImages, built } = harness([plain], new Map());
    expect((await branchImages.resolve(root)).size).toBe(0);
    expect(built).toEqual([]);
  });

  it("propagates a build failure to every worktree waiting on the same tag", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const one = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const two = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    const branchImages = createBranchImages({
      images: [IMAGE],
      scope,
      baseFingerprints: base,
      exists: async () => false,
      build: async () => {
        throw new SandbarError("npm ci failed");
      },
      log: () => {},
    });
    // The tag is content-addressed, so a build that failed for one worktree
    // fails for every worktree that asked for the same bytes — a waiter that
    // silently got an unbuilt image would gate against a container that cannot
    // start.
    const results = await Promise.allSettled([
      branchImages.resolve(one),
      branchImages.resolve(two),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });
});
