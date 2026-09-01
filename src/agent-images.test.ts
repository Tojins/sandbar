import { describe, expect, it } from "vitest";

import { CLAUDE_CODE_VERSION, CODEX_VERSION } from "./agent-providers.js";
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
    expect(builds[0].content).toContain(`@openai/codex@${CODEX_VERSION}`);
    expect(builds[0].content).not.toContain("anthropic");
  });

  it("pins both providers and keeps claude lifecycle scripts enabled", () => {
    const file = agentToolsContainerfile("base", ["claude", "codex"]);
    expect(file).toContain(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
    expect(file).toContain("--allow-scripts=@anthropic-ai/claude-code");
    expect(file).toContain(`@openai/codex@${CODEX_VERSION}`);
  });

  it("rebuilds when the base provenance is unknown even if the derived tag exists", async () => {
    let builds = 0;
    await createAgentImages({
      declaredBaseTag: "base",
      providers: ["claude"],
      scope: runScope("/unknown-base"),
      inputsLabel: async () => "apparently-present",
      // First lookup is the base. Make it unknown; subsequent lookup may look
      // present, and still must not be trusted.
      build: async () => { builds += 1; },
      probeUid: async () => 0,
      log: () => {},
    });
    // The all-present seam above gives the base known provenance, so prove the
    // complementary unknown case with a stateful reader.
    let reads = 0;
    await createAgentImages({
      declaredBaseTag: "other",
      providers: ["claude"],
      scope: runScope("/unknown-base-2"),
      inputsLabel: async () => (++reads === 1 ? null : "apparently-present"),
      build: async () => { builds += 1; },
      probeUid: async () => 0,
      log: () => {},
    });
    expect(builds).toBe(2);
  });
});
