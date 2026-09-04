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
  type AgentImages,
  type BuildOptions,
  createBranchImages,
  parseInputsLabel,
  resolveSandboxImage,
} from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { fingerprintImageInputs } from "./image-inputs.js";
import {
  type RunScope,
  isVariantImageTagIn,
  runScope,
  variantImageTag,
} from "./naming.js";

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

// The declared tags a caller is about to run. Required at every call since #46,
// because the gate and the agent sandbox share one resolver and ask about
// different containers.
const runs = (...tags: string[]): ReadonlySet<string> => new Set(tags);

const agentImages = (
  augment: (baseTag: string) => Promise<string> = async (tag) => `agent:${tag}`,
): AgentImages => ({
  declaredTag: "agent:sandbox",
  augment,
  builtTags: () => [],
});

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

  it("covers a multi-stage target", async () => {
    const root = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "{}",
    });
    expect(await fp(root, { ...IMAGE, target: "dev" })).not.toBe(
      await fp(root, { ...IMAGE, target: "service" }),
    );
  });

  it("covers context only when it was explicitly declared", async () => {
    const root = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "{}",
    });
    expect(await fp(root, { ...IMAGE, context: "" })).not.toBe(await fp(root));
    expect(await fp(root, { ...IMAGE, context: "" })).not.toBe(
      await fp(root, { ...IMAGE, context: "docker" }),
    );
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

  it("recognises its own output under the same scope, and nothing else", () => {
    // What makes the scope segment more than a comment: the startup sweep uses
    // this to reclaim ~6GB-class images a crashed run left, and it must not
    // reach another workdir's live ones.
    const other = runScope("/elsewhere") as RunScope;
    for (const base of [
      "sandbar-outdoor",
      "sandbar-outdoor:latest",
      "localhost/x/y:v1",
      "registry.example:5000/x",
    ]) {
      const tag = variantImageTag(base, scope, "9f2e1d70ab");
      expect(isVariantImageTagIn(scope, tag)).toBe(true);
      expect(isVariantImageTagIn(other, tag)).toBe(false);
      // The base image itself is never swept — it is what `ensureImages` built.
      expect(isVariantImageTagIn(scope, base)).toBe(false);
    }
    // An untagged reference and a coincidental lookalike are not ours.
    expect(isVariantImageTagIn(scope, "localhost/x/y")).toBe(false);
    expect(isVariantImageTagIn(scope, `app:sb-${scope}-nothex12`)).toBe(false);
    expect(isVariantImageTagIn(scope, `app:sb-${scope}-9f2e1d70-more`)).toBe(
      false,
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
    // tag -> the fingerprint that tag was built from, i.e. what podman would
    // report from the image's `sandbar.inputs` label.
    const present = new Map<string, string>();
    const branchImages = createBranchImages({
      images,
      scope,
      baseFingerprints: base,
      inputsLabel: async (tag) => present.get(tag) ?? null,
      build: async (image: BuiltImage, opts: BuildOptions) => {
        built.push({ tag: image.tag, root: opts.root });
        present.set(image.tag, opts.fingerprint ?? "");
      },
      log: () => {},
    });
    return { branchImages, built, present };
  }

  it("maps nothing and builds nothing when the worktree matches the base image", async () => {
    const root = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const base = new Map([["app", (await fp(root))!]]);
    const { branchImages, built } = harness([IMAGE], base);
    expect((await branchImages.resolve(root, runs("app"))).size).toBe(0);
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

    const map = await branchImages.resolve(branch, runs("app"));
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
      branchImages.resolve(one, runs("app")),
      branchImages.resolve(two, runs("app")),
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

    expect((await branchImages.resolve(branch, runs("app"))).size).toBe(0);
    await writeFile(join(branch, "package-lock.json"), '{"added":"dep"}');
    expect((await branchImages.resolve(branch, runs("app"))).get("app")).toBe(
      variantImageTag("app", scope, (await fp(branch))!),
    );
    expect(built).toHaveLength(1);
  });

  it("reuses an existing variant tag rather than rebuilding it", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    const { branchImages, built, present } = harness([IMAGE], base);
    const fingerprint = (await fp(branch))!;
    present.set(variantImageTag("app", scope, fingerprint), fingerprint);

    expect((await branchImages.resolve(branch, runs("app"))).size).toBe(1);
    expect(built).toEqual([]);
    // Still reported as this run's, so cleanup reaches it.
    expect(branchImages.builtTags()).toHaveLength(1);
  });

  it("rebuilds a namesake tag whose recorded inputs do not match — the tag is only 32 bits of the hash", () => {
    // The variant tag carries 8 hex of the fingerprint, so the NAME is a 32-bit
    // cache key. Trusting it would gate against whatever a colliding (or
    // crashed-run) tag happens to hold. The full fingerprint is on the image's
    // label, and this is the same check the base-image path already makes.
    return (async () => {
      const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
      const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
      const base = new Map([["app", (await fp(source))!]]);
      const { branchImages, built, present } = harness([IMAGE], base);
      present.set(
        variantImageTag("app", scope, (await fp(branch))!),
        "a-different-fingerprint-entirely",
      );

      expect((await branchImages.resolve(branch, runs("app"))).size).toBe(1);
      expect(built).toHaveLength(1);
    })();
  });

  it("retries a build that failed, rather than caching the rejection for the run", async () => {
    // Cached, one transient failure (a registry 5xx on the FROM pull, ENOSPC)
    // is a DEAD END: the fingerprint does not move unless the agent touches the
    // lockfile again, so every remaining attempt re-throws the same stale error
    // and no build is ever attempted again — the issue lands on agent-stuck
    // with a trace telling its author their dependencies do not install.
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    let attempts = 0;
    const branchImages = createBranchImages({
      images: [IMAGE],
      scope,
      baseFingerprints: base,
      inputsLabel: async () => null,
      build: async () => {
        attempts += 1;
        if (attempts === 1) throw new SandbarError("registry 503");
      },
      log: () => {},
    });

    await expect(branchImages.resolve(branch, runs("app"))).rejects.toThrow("registry 503");
    // The next gate run gets a real attempt, not the corpse of the last one.
    await expect(branchImages.resolve(branch, runs("app"))).resolves.toEqual(
      new Map([["app", variantImageTag("app", scope, (await fp(branch))!)]]),
    );
    expect(attempts).toBe(2);
  });

  it("re-probes the D3 uid of a variant it just built, as a build failure", async () => {
    // The Containerfile's own bytes are in the fingerprint, so a branch is free
    // to change the recipe's USER. The startup check runs once over the
    // DECLARED images and would never see it, and the result is a silent
    // mid-gate EACCES — the one failure D3 exists to convert into a refusal.
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    const make = (uid: number) =>
      createBranchImages({
        images: [IMAGE],
        scope,
        baseFingerprints: base,
        inputsLabel: async () => null,
        build: async () => {},
        log: () => {},
        worktreeMountingTags: new Set(["app"]),
        hostUid: 1000,
        probeUid: async () => uid,
      });

    await expect(make(1234).resolve(branch, runs("app"))).rejects.toThrow(/uid 1234/);
    // Root and the host uid are both fine — rootless podman maps container root
    // to the invoking user.
    await expect(make(0).resolve(branch, runs("app"))).resolves.toBeInstanceOf(Map);
    await expect(make(1000).resolve(branch, runs("app"))).resolves.toBeInstanceOf(Map);
  });

  it("does not probe the uid of an image no worktree-mounting container runs", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    let probed = 0;
    const branchImages = createBranchImages({
      images: [IMAGE],
      scope,
      baseFingerprints: base,
      inputsLabel: async () => null,
      build: async () => {},
      log: () => {},
      worktreeMountingTags: new Set(["something-else"]),
      hostUid: 1000,
      probeUid: async () => {
        probed += 1;
        return 999;
      },
    });
    // Widening the check to every image would refuse a perfectly good stack
    // whose mariadb runs as uid 999 and never writes to the tree.
    await expect(branchImages.resolve(branch, runs("app"))).resolves.toBeInstanceOf(Map);
    expect(probed).toBe(0);
  });

  it("ignores images that declare no inputs", async () => {
    const root = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const plain: BuiltImage = { tag: "sandbox", containerfile: "Containerfile" };
    const { branchImages, built } = harness([plain], new Map());
    expect((await branchImages.resolve(root, runs("sandbox"))).size).toBe(0);
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
      inputsLabel: async () => null,
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
      branchImages.resolve(one, runs("app")),
      branchImages.resolve(two, runs("app")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("answers only about the tags the caller runs", async () => {
    // The gate and the agent sandbox share one resolver. A gate run that also
    // resolved the sandbox's entry would pay for a build no container in that
    // stack runs — and, since a build can fail because of the branch, would let
    // that failure red a gate the image has nothing to do with.
    const source = await tree({
      Containerfile: "FROM x",
      "Containerfile.agent": "FROM y",
      "package-lock.json": "{}",
    });
    const branch = await tree({
      Containerfile: "FROM x",
      "Containerfile.agent": "FROM y",
      "package-lock.json": "b",
    });
    const agent: BuiltImage = {
      tag: "agent",
      containerfile: "Containerfile.agent",
      rebuildOn: ["package-lock.json"],
    };
    const base = new Map([
      ["app", (await fp(source))!],
      ["agent", (await fp(source, agent))!],
    ]);
    const { branchImages, built } = harness([IMAGE, agent], base);

    const map = await branchImages.resolve(branch, runs("app"));
    expect([...map.keys()]).toEqual(["app"]);
    expect(built.map((b) => b.tag)).toEqual([
      variantImageTag("app", scope, (await fp(branch))!),
    ]);
  });

  it("shares one build when the same entry is asked for in both roles", async () => {
    // A consumer may give one image both roles (sandbar's own config does), and
    // the tag is content-addressed, so the sandbox's resolution and the gate's
    // name the same bytes. Two builds of it would be the thing the in-flight
    // map exists to prevent, arriving through the second caller.
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["app", (await fp(source))!]]);
    const { branchImages, built } = harness([IMAGE], base);

    const sandbox = await resolveSandboxImage({
      declaredTag: "app",
      agentImages: agentImages(),
      worktreePath: branch,
      branchImages,
      gateRunsSameImage: true,
    });
    const gate = await branchImages.resolve(branch, runs("app"));
    expect(sandbox).toBe(`agent:${gate.get("app")}`);
    expect(built).toHaveLength(1);
  });
});

// #46 — the agent sandbox's image is a function of the branch too, and the
// issue worktree exists by the time the sandbox is created.
describe("resolveSandboxImage", () => {
  const scope = runScope("/repo") as RunScope;
  // The tag is part of the fingerprint, so the base map has to be built from
  // the same entry the resolver will use.
  const SANDBOX: BuiltImage = { ...IMAGE, tag: "sandbox" };

  function harness(base: Map<string, string>, build: () => Promise<void>) {
    const present = new Map<string, string>();
    return createBranchImages({
      images: [SANDBOX],
      scope,
      baseFingerprints: base,
      inputsLabel: async (tag) => present.get(tag) ?? null,
      build,
      log: () => {},
    });
  }

  it("runs the branch's own image when it moved a declared input", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["sandbox", (await fp(source, SANDBOX))!]]);
    const image = await resolveSandboxImage({
      declaredTag: "sandbox",
      agentImages: agentImages(),
      worktreePath: branch,
      branchImages: harness(base, async () => {}),
      gateRunsSameImage: false,
    });
    expect(image).toBe(
      `agent:${variantImageTag("sandbox", scope, (await fp(branch, SANDBOX))!)}`,
    );
  });

  it("runs the declared tag when the branch changed nothing, and when nothing resolves at all", async () => {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const base = new Map([["sandbox", (await fp(source, SANDBOX))!]]);
    let builds = 0;
    await expect(
      resolveSandboxImage({
        declaredTag: "sandbox",
        agentImages: agentImages(),
        worktreePath: source,
        branchImages: harness(base, async () => {
          builds += 1;
        }),
        gateRunsSameImage: false,
      }),
    ).resolves.toBe("agent:sandbox");
    expect(builds).toBe(0);
    // A run with no per-branch resolver — a host that declares no `rebuildOn`.
    await expect(
      resolveSandboxImage({
        declaredTag: "sandbox",
        agentImages: agentImages(),
        worktreePath: source,
        gateRunsSameImage: false,
      }),
    ).resolves.toBe("agent:sandbox");
  });

  // A build that fails, in both configurations. The fallback direction is the
  // same in each — throwing wedges the branch rather than failing it, since the
  // sandbox is where the fix gets written and the branch outlives the cycle —
  // but what the operator is owed differs, and that is the part a message can
  // get wrong.
  async function fallback(gateRunsSameImage: boolean) {
    const source = await tree({ Containerfile: "FROM x", "package-lock.json": "{}" });
    const branch = await tree({ Containerfile: "FROM x", "package-lock.json": "b" });
    const base = new Map([["sandbox", (await fp(source, SANDBOX))!]]);
    const reported: string[] = [];
    const image = await resolveSandboxImage({
      declaredTag: "sandbox",
      agentImages: agentImages(),
      worktreePath: branch,
      branchImages: harness(base, async () => {
        throw new SandbarError("npm ci: ETARGET no matching version");
      }),
      gateRunsSameImage,
      onFallback: (line) => {
        reported.push(line);
      },
    });
    return { image, reported };
  }

  it("falls back to the declared tag when the build fails, and never silently", async () => {
    const { image, reported } = await fallback(false);
    expect(image).toBe("agent:sandbox");
    // The operator's only sign that the agent is working in an environment a
    // commit behind its own branch.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("ETARGET");
  });

  it("falls back to the augmented declared image when variant augmentation fails", async () => {
    const source = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "{}",
    });
    const branch = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "b",
    });
    const base = new Map([["sandbox", (await fp(source, SANDBOX))!]]);
    const attempted: string[] = [];
    const reported: string[] = [];
    const image = await resolveSandboxImage({
      declaredTag: "sandbox",
      agentImages: agentImages(async (tag) => {
        attempted.push(tag);
        throw new SandbarError("registry unavailable");
      }),
      worktreePath: branch,
      branchImages: harness(base, async () => {}),
      gateRunsSameImage: true,
      onFallback: (line) => {
        reported.push(line);
      },
    });
    expect(attempted).toEqual([
      variantImageTag("sandbox", scope, (await fp(branch, SANDBOX))!),
    ]);
    expect(image).toBe("agent:sandbox");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("could not append the run-owned agent tools");
    expect(reported[0]).toContain("environment is a commit behind its own branch");
    expect(reported[0]).toContain("The gate runs the successfully resolved branch image");
    expect(reported[0]).toContain("this line is the only report it gets");
  });

  it("does not claim a gate runs the sandbox image when no gate container does", async () => {
    const source = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "{}",
    });
    const branch = await tree({
      Containerfile: "FROM x",
      "package-lock.json": "changed",
    });
    const base = new Map([["sandbox", (await fp(source, SANDBOX))!]]);
    const reported: string[] = [];
    await resolveSandboxImage({
      declaredTag: "sandbox",
      agentImages: agentImages(async () => {
        throw new SandbarError("registry unavailable");
      }),
      worktreePath: branch,
      branchImages: harness(base, async () => {}),
      gateRunsSameImage: false,
      onFallback: (line) => {
        reported.push(line);
      },
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("No `gateStack` container runs the sandbox image");
    expect(reported[0]).not.toContain("The gate runs the successfully resolved branch image");
  });

  it("promises a second report only when a gate container runs the same image", async () => {
    // The compensating control for falling back is that the GATE resolves the
    // same entry and reds against the branch — and that exists only when a
    // gateStack container runs this tag. `startStack` asks the resolver about
    // the images its own spec names, so for a sandbox-only entry — the config
    // this feature is for — no gate run ever touches it, the gate goes green on
    // images that built, and this line is the whole of the report. Telling that
    // operator to wait for a red sends them to watch for something that cannot
    // arrive.
    const alone = (await fallback(false)).reported[0]!;
    expect(alone).toMatch(/only report/);
    expect(alone).not.toMatch(/will red/);

    const shared = (await fallback(true)).reported[0]!;
    expect(shared).toMatch(/will red with this build's output, against the branch/);
    expect(shared).not.toMatch(/only report/);
  });
});
