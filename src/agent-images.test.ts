import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AGENT_PROVIDER_PACKAGES } from "./agent-providers.js";
import {
  type BuildOptions,
  agentToolsContainerfile,
  buildArgv,
  createAgentImages,
} from "./ensure-images.js";
import { runScope } from "./naming.js";

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
      probeUid: async () => 0,
      log: () => {},
    });
    expect(builds).toHaveLength(1);
    expect(builds[0].argv.at(-1)).toBe("-");
    expect(builds[0].content).toContain(AGENT_PROVIDER_PACKAGES.codex.spec);
    expect(builds[0].content).not.toContain("anthropic");
  });

  it("pins both providers and keeps claude lifecycle scripts enabled", () => {
    const file = agentToolsContainerfile("base", ["claude", "codex"]);
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.claude.spec);
    expect(file).toContain("--allow-scripts=@anthropic-ai/claude-code");
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.codex.spec);
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
      probeUid: async () => 0,
      log: () => {},
    });
    expect(builds).toBe(1);
  });

  it("reuses a derived image whose label matches a labelled base and toolset", async () => {
    const toolset = `codex: ${AGENT_PROVIDER_PACKAGES.codex.spec}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["base-fp", toolset]))
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
      probeUid: async () => 0,
      log: () => {},
    });
    expect(builds).toBe(0);
  });
});
