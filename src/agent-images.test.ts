import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_PROVIDER_NAMES,
  AGENT_PROVIDER_PACKAGES,
} from "./agent-providers.js";
import {
  type BuildOptions,
  type PreparedAgentArtifacts,
  agentToolsContainerfile,
  buildArgv,
  createAgentImages,
  sweepBranchImages,
} from "./ensure-images.js";
import { runScope, variantImageTag } from "./naming.js";

async function fakeAgentArtifacts(
  providers: readonly (typeof AGENT_PROVIDER_NAMES)[number][],
): Promise<PreparedAgentArtifacts> {
  const root = await mkdtemp(join(tmpdir(), "sandbar-agent-tools-test-"));
  const sha256: Record<string, string> = {};
  const arch = process.arch as "x64" | "arm64";
  for (const provider of providers) {
    for (const artifact of AGENT_PROVIDER_PACKAGES[provider].artifacts[arch]) {
      const name = `${provider}-${artifact.variant}`;
      const content = `test ${name}`;
      await writeFile(join(root, name), content);
      sha256[name] = createHash("sha256").update(content).digest("hex");
    }
  }
  return {
    root,
    verify: async (provider) => {
      for (const artifact of AGENT_PROVIDER_PACKAGES[provider].artifacts[arch]) {
        const name = `${provider}-${artifact.variant}`;
        const actual = createHash("sha256")
          .update(await readFile(join(root, name)))
          .digest("hex");
        if (actual !== sha256[name]) {
          throw new Error(
            `staged artifact ${provider}/${process.arch} failed re-verification`,
          );
        }
      }
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

describe("run-owned agent images", () => {
  it("generates a no-context build containing only the routed, pinned tools", async () => {
    const builds: Array<{ files: string[]; content: string; argv: string[] }> = [];
    await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["codex"],
      scope: runScope("/agent-images"),
      prepareArtifacts: fakeAgentArtifacts,
      inputsLabel: async (tag) => (tag === "localhost/app:base" ? "base-fp" : null),
      build: async (image, opts: BuildOptions) => {
        const root = opts.contextRoot!;
        builds.push({
          files: (await readdir(root)).sort(),
          content: await readFile(`${root}/Containerfile`, "utf8"),
          argv: buildArgv(image, opts),
        });
      },
      log: () => {},
    });
    expect(builds).toHaveLength(1);
    expect(builds[0].argv.at(-1)).toBe("-");
    expect(builds[0].files).toEqual(["Containerfile", "codex-static"]);
    expect(builds[0].content).toContain("COPY --chmod=0755 codex-static");
    expect(builds[0].content).not.toContain("claude");
  });

  it("copies and probes both standalone provider binaries", () => {
    const file = agentToolsContainerfile("base", ["claude", "codex"]);
    expect(file).toContain("COPY --chmod=0755 claude-glibc claude-musl /tmp/");
    expect(file).toContain("cp /tmp/claude-musl /usr/local/bin/claude");
    expect(file).toContain("cp /tmp/claude-glibc /usr/local/bin/claude");
    expect(file).toContain("COPY --chmod=0755 codex-static /usr/local/bin/codex");
    expect(file).toContain("claude --version && codex --version && git --version");
    for (const artifacts of Object.values(AGENT_PROVIDER_PACKAGES.claude.artifacts)) {
      for (const artifact of artifacts) expect(file).toContain(artifact.sha256);
    }
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.codex.artifacts.arm64[0]!.sha256);
    expect(file).not.toContain("npm");
  });

  it("pins a checksum and both supported architectures for every provider", () => {
    for (const provider of AGENT_PROVIDER_NAMES) {
      const pin = AGENT_PROVIDER_PACKAGES[provider];
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
      for (const arch of ["x64", "arm64"] as const) {
        for (const artifact of pin.artifacts[arch]) {
          expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
      }
    }
  });

  it("rebuilds when the base provenance is unknown even if the derived tag exists", async () => {
    let builds = 0;
    let reads = 0;
    await createAgentImages({
      declaredBaseTag: "base",
      providers: ["claude"],
      scope: runScope("/unknown-base"),
      prepareArtifacts: fakeAgentArtifacts,
      inputsLabel: async () => (++reads === 1 ? null : "apparently-present"),
      build: async () => {
        builds += 1;
      },
      log: () => {},
    });
    expect(builds).toBe(1);
  });

  it("reuses a derived image whose label matches a labelled base and toolset", async () => {
    const containerfile = agentToolsContainerfile("base", ["codex"]);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["base-fp", containerfile]))
      .digest("hex");
    let reads = 0;
    let builds = 0;
    let artifactPreparations = 0;
    await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope: runScope("/cached-agent-image"),
      prepareArtifacts: async (providers) => {
        artifactPreparations += 1;
        return fakeAgentArtifacts(providers);
      },
      inputsLabel: async () => (++reads === 1 ? "base-fp" : fingerprint),
      build: async () => {
        builds += 1;
      },
      log: () => {},
    });
    expect(builds).toBe(0);
    expect(artifactPreparations).toBe(0);
  });

  it("deduplicates concurrent augmentation of the same base", async () => {
    let builds = 0;
    let releaseBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const imagesPromise = createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope: runScope("/deduplicated-agent-image"),
      prepareArtifacts: fakeAgentArtifacts,
      inputsLabel: async () => null,
      build: async () => {
        builds += 1;
        if (builds === 2) await buildStarted;
      },
      log: () => {},
    });
    const images = await imagesPromise;
    const augmentations = Promise.all([
      images.augment("variant"),
      images.augment("variant"),
      images.augment("variant"),
    ]);
    releaseBuild();
    const [first, second, third] = await augmentations;
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(builds).toBe(2);
  });

  it("re-verifies staged tools before augmenting a later variant", async () => {
    const artifacts = await fakeAgentArtifacts(["codex"]);
    const images = await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope: runScope("/reverified-agent-image"),
      prepareArtifacts: async () => artifacts,
      inputsLabel: async () => null,
      build: async () => {},
      log: () => {},
    });
    await writeFile(join(artifacts.root, "codex-static"), "branch replacement");
    await expect(images.augment("variant")).rejects.toThrow(
      /staged artifact codex\/.+ failed re-verification/,
    );
  });

  it("retries artifact staging after a transient failure", async () => {
    const containerfile = agentToolsContainerfile("base", ["codex"]);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["base-fp", containerfile]))
      .digest("hex");
    const declaredTag = variantImageTag(
      "base",
      runScope("/artifact-retry"),
      fingerprint,
    );
    let preparations = 0;
    const images = await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope: runScope("/artifact-retry"),
      prepareArtifacts: async (providers) => {
        preparations += 1;
        if (preparations === 1) throw new Error("transient CDN failure");
        return fakeAgentArtifacts(providers);
      },
      inputsLabel: async (tag) => tag === "base"
        ? "base-fp"
        : tag === declaredTag ? fingerprint : null,
      build: async () => {},
      log: () => {},
    });
    await expect(images.augment("variant")).rejects.toThrow(/transient CDN failure/);
    await expect(images.augment("variant")).resolves.toMatch(/^variant:sb-/);
    expect(preparations).toBe(2);
  });

  it("sweeps augmented children before their branch-variant parents", async () => {
    const scope = runScope("/nested-agent-images");
    const parent = variantImageTag("base", scope, "a".repeat(64));
    const child = variantImageTag(parent, scope, "b".repeat(64));
    const removed: string[] = [];
    const result = await sweepBranchImages(scope, async (args) => {
      if (args[0] === "images") return { stdout: `${parent}\n${child}\n` };
      removed.push(args.at(-1) ?? "");
      return { stdout: "" };
    });
    expect(result.failures).toEqual([]);
    expect(removed).toEqual([child, parent]);
  });

  it("names the base and routed toolset when augmentation fails", async () => {
    await expect(
      createAgentImages({
        declaredBaseTag: "broken-base",
        providers: ["codex"],
        scope: runScope("/failed-agent-image"),
        prepareArtifacts: fakeAgentArtifacts,
        inputsLabel: async () => null,
        build: async () => {
          throw new Error("registry unavailable");
        },
        log: () => {},
      }),
    ).rejects.toThrow(
      `could not augment image 'broken-base' with agent tools codex: ${AGENT_PROVIDER_PACKAGES.codex.version}: registry unavailable`,
    );
  });
});
