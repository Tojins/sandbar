import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
    const builds: Array<{ content: string; argv: string[] }> = [];
    await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["codex"],
      scope: runScope("/agent-images"),
      inputsLabel: async (tag) => (tag === "localhost/app:base" ? "base-fp" : null),
      build: async (image, opts: BuildOptions) => {
        builds.push({ content: opts.content ?? "", argv: buildArgv(image, opts) });
      },
      log: () => {},
    });
    expect(builds).toHaveLength(1);
    expect(builds[0].argv.at(-1)).toBe("-");
    expect(builds[0].content).toContain(AGENT_PROVIDER_PACKAGES.codex.spec);
    expect(builds[0].content).not.toContain("anthropic");
    expect(builds[0].content).toContain("USER 0\nRUN npm install");
  });

  it("pins both providers and keeps claude lifecycle scripts enabled", () => {
    const file = agentToolsContainerfile("base", ["claude", "codex"]);
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.claude.spec);
    expect(file).toContain("--allow-scripts=@anthropic-ai/claude-code");
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.codex.spec);
  });

  // The inverse of the guard this used to be. While the host Containerfile still
  // carried its own CLI installs, the test asserted the two pins AGREED; #75
  // made the driver append the routed providers after resolving the image, and
  // the pin move deleted the host copies — at which point an agreement test
  // asserts the opposite of the rule. The rule the Containerfile now states in
  // prose is "do not re-add a host copy": an unpinned one drifts from the
  // parser the driver couples to (`parsedOutputOnly`), and the driver's install
  // wins over it anyway, so the host copy is invisible until the day it is the
  // one that ran. Asserting the ABSENCE is what keeps that prose enforced.
  it("installs no agent CLI in the host image — the driver owns them (#75)", () => {
    const containerfile = readFileSync(
      new URL("../Containerfile", import.meta.url),
      "utf8",
    );
    for (const provider of AGENT_PROVIDER_NAMES) {
      const spec = AGENT_PROVIDER_PACKAGES[provider].spec;
      // The spec is `<name>@<version>`; the name is what an install line has to
      // mention at all, pinned or not, so it is the term to look for.
      const packageName = spec.slice(0, spec.lastIndexOf("@"));
      expect(containerfile, provider).not.toContain(packageName);
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
      `could not augment image 'broken-base' with agent tools codex: ${AGENT_PROVIDER_PACKAGES.codex.spec}: registry unavailable`,
    );
  });
});
