import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  AGENT_PROVIDER_NAMES,
  AGENT_PROVIDER_PACKAGES,
} from "./agent-providers.js";
import {
  type BuildOptions,
  agentToolsContainerfile,
  buildArgv,
  createAgentImages,
  sweepBranchImages,
} from "./ensure-images.js";
import { runScope, variantImageTag } from "./naming.js";

describe("run-owned agent images", () => {
  it("generates a no-context build containing only the routed, pinned tools", async () => {
    const builds: Array<{ files: string[]; content: string; argv: string[] }> = [];
    await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["codex"],
      scope: runScope("/agent-images"),
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
    expect(builds[0].files).toEqual(["Containerfile", "codex"]);
    expect(builds[0].content).toContain("COPY --chmod=0755 codex");
    expect(builds[0].content).not.toContain("claude");
  });

  it("copies and probes both standalone provider binaries", () => {
    const file = agentToolsContainerfile("base", ["claude", "codex"]);
    expect(file).toContain("COPY --chmod=0755 claude /usr/local/bin/claude");
    expect(file).toContain("COPY --chmod=0755 codex /usr/local/bin/codex");
    expect(file).toContain("claude --version && codex --version && git --version");
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.claude.artifacts.x64.sha256);
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.codex.artifacts.arm64.sha256);
    expect(file).not.toContain("npm");
  });

  it("pins a checksum and both supported architectures for every provider", () => {
    for (const provider of AGENT_PROVIDER_NAMES) {
      const pin = AGENT_PROVIDER_PACKAGES[provider];
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pin.artifacts.x64.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pin.artifacts.arm64.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rebuilds when the base provenance is unknown even if the derived tag exists", async () => {
    let builds = 0;
    let reads = 0;
    await createAgentImages({
      declaredBaseTag: "base",
      providers: ["claude"],
      scope: runScope("/unknown-base"),
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
    await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope: runScope("/cached-agent-image"),
      inputsLabel: async () => (++reads === 1 ? "base-fp" : fingerprint),
      build: async () => {
        builds += 1;
      },
      log: () => {},
    });
    expect(builds).toBe(0);
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
