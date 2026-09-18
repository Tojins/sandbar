import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_PROVIDER_NAMES, AGENT_PROVIDER_PACKAGES } from "./agent-providers.js";
import {
  agentArtifactBinary,
  agentArtifactName,
  agentToolsContainerfile,
  agentToolsFingerprint,
  agentToolsImageContainerfile,
  createAgentImages,
  detectImageLibcArgv,
  hostAgentArchitecture,
  selectedAgentArtifact,
  selectedAgentArtifacts,
} from "./agent-tools.js";
import {
  type BuildOptions,
  formatImageRecord,
} from "./ensure-images.js";
import {
  runScope,
  toolsImageTag,
  variantImageTag,
} from "./naming.js";

type CapturedBuild = {
  readonly tag: string;
  readonly identity: string;
  readonly options: BuildOptions;
  readonly recipe: string;
};

describe("run-owned agent images", () => {
  it("downloads pinned tools into a persistent image with Buildah checksum verification", () => {
    const recipe = agentToolsImageContainerfile(
      "localhost/app:base",
      ["claude", "codex"],
      { arch: "x64", libc: "glibc" },
    );
    const selected = (["claude", "codex"] as const).flatMap((provider) =>
      selectedAgentArtifacts(
        AGENT_PROVIDER_PACKAGES[provider], "x64", "glibc", provider,
      ).map((artifact) => ({ provider, artifact })),
    );
    expect(recipe).toContain("FROM localhost/app:base AS downloads");
    expect(recipe).toContain("FROM scratch");
    expect(recipe).toContain("COPY --from=downloads /usr/local/bin/ /usr/local/bin/");
    for (const { provider, artifact } of selected) {
      expect(recipe).toContain(
        `ADD --checksum=sha256:${artifact.sha256} ${artifact.url}`,
      );
      expect(recipe).toContain(
        `/usr/local/bin/${agentArtifactBinary(provider, artifact)}`,
      );
    }
    expect(recipe).toContain("tar -xzf /tmp/codex-static.download");
    expect(recipe).toContain('if [ "$#" -ne 1 ] || [ ! -f "$1" ]');
  });

  it("augments a base by copying only the selected libc tools image binaries", () => {
    const recipe = agentToolsContainerfile(
      "base",
      "sandbar-agent-tools:current",
      ["claude", "codex"],
      { arch: "x64", libc: "glibc" },
    );
    expect(recipe).toContain(
      "COPY --from=sandbar-agent-tools:current /usr/local/bin/claude " +
        "/usr/local/bin/claude",
    );
    expect(recipe).toContain(
      "COPY --from=sandbar-agent-tools:current /usr/local/bin/codex-code-mode-host " +
        "/usr/local/bin/codex-code-mode-host",
    );
    expect(recipe).toContain(
      "claude --version && codex --version && " +
        "test -x /usr/local/bin/codex-code-mode-host && git --version",
    );
    expect(recipe).toContain("command -v git >/dev/null");
    expect(recipe).toContain("useradd -u 1000 -m -d /home/agent agent");
    expect(recipe).not.toContain("ADD --checksum");
  });

  it("builds a persistent tools image and tiny recipe-only augmentation context", async () => {
    const builds: CapturedBuild[] = [];
    const images = await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["codex"],
      scope: runScope("/agent-images"),
      inputsLabel: async (tag) => tag === "localhost/app:base" ? "base-fp" : null,
      build: async (image, options) => {
        expect(await readdir(options.contextRoot!)).toEqual(["Containerfile"]);
        builds.push({
          tag: image.tag,
          identity: image.containerfile,
          options,
          recipe: await readFile(join(options.contextRoot!, "Containerfile"), "utf8"),
        });
      },
      log: () => {},
    });

    expect(builds).toHaveLength(2);
    expect(builds[0]!.identity).toBe("<generated-agent-tools-download>");
    expect(builds[0]!.recipe).toContain("ADD --checksum=sha256:");
    expect(builds[1]!.identity).toBe("<generated-agent-tools-augmentation>");
    expect(builds[1]!.recipe).toContain(`COPY --from=${builds[0]!.tag}`);
    expect(builds[1]!.recipe).not.toContain("ADD --checksum");
    expect(images.builtTags()).toEqual([images.declaredTag]);
    expect(images.builtTags()).not.toContain(builds[0]!.tag);
    expect(images.liveTags()).toEqual([builds[0]!.tag, images.declaredTag]);
    for (const build of builds) {
      await expect(access(build.options.contextRoot!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("disposes generated contexts immediately when augmentation fails", async () => {
    const contextRoots: string[] = [];
    await expect(createAgentImages({
      declaredBaseTag: "broken-base",
      providers: ["codex"],
      scope: runScope("/failed-agent-context"),
      inputsLabel: async () => null,
      build: async (image, options) => {
        contextRoots.push(options.contextRoot!);
        expect(await readdir(options.contextRoot!)).toEqual(["Containerfile"]);
        if (image.containerfile === "<generated-agent-tools-augmentation>") {
          throw new Error("augmentation failed");
        }
      },
      log: () => {},
    })).rejects.toThrow("augmentation failed");
    expect(contextRoots).toHaveLength(2);
    for (const contextRoot of contextRoots) {
      await expect(access(contextRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reuses persistent tools and an augmented image with matching full labels", async () => {
    const scope = runScope("/cached-agent-image");
    const arch = hostAgentArchitecture();
    const toolsFingerprint = agentToolsFingerprint(["codex"], "glibc", { arch });
    const toolsTag = toolsImageTag(scope, "glibc", toolsFingerprint);
    const recipe = agentToolsContainerfile(
      "base", toolsTag, ["codex"], { arch, libc: "glibc" },
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["base-fp", recipe]))
      .digest("hex");
    const augmentedTag = variantImageTag("base", scope, fingerprint);
    const labels = new Map([
      ["base", "base-fp"],
      [toolsTag, toolsFingerprint],
      [augmentedTag, fingerprint],
    ]);
    const records: Array<{ tag: string; built: boolean; reason: string }> = [];
    let builds = 0;

    const images = await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope,
      inputsLabel: async (tag) => labels.get(tag) ?? null,
      build: async () => { builds += 1; },
      log: () => {},
      onImage: (record) => {
        records.push({ tag: record.tag, built: record.built, reason: record.reason });
      },
    });

    expect(builds).toBe(0);
    expect(images.declaredTag).toBe(augmentedTag);
    expect(records).toEqual([
      { tag: toolsTag, built: false, reason: "tools-current" },
      { tag: augmentedTag, built: false, reason: "variant-current" },
    ]);
    expect(images.liveTags()).toEqual([toolsTag, augmentedTag]);
  });

  it("rebuilds a matching augmented image when the base is unlabelled", async () => {
    const scope = runScope("/unlabelled-base-image");
    const arch = hostAgentArchitecture();
    const toolsFingerprint = agentToolsFingerprint(
      ["codex"], "glibc", { arch },
    );
    const toolsTag = toolsImageTag(scope, "glibc", toolsFingerprint);
    const recipe = agentToolsContainerfile(
      "base", toolsTag, ["codex"], { arch, libc: "glibc" },
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["unknown", recipe]))
      .digest("hex");
    const augmentedTag = variantImageTag("base", scope, fingerprint);
    const records: Array<{ tag: string; built: boolean; reason: string }> = [];
    const builds: string[] = [];

    const images = await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope,
      inputsLabel: async (tag) => {
        if (tag === toolsTag) return toolsFingerprint;
        if (tag === augmentedTag) return fingerprint;
        return null;
      },
      build: async (image) => { builds.push(image.containerfile); },
      log: () => {},
      onImage: (record) => {
        records.push({
          tag: record.tag,
          built: record.built,
          reason: record.reason,
        });
      },
    });

    expect(images.declaredTag).toBe(augmentedTag);
    expect(builds).toEqual(["<generated-agent-tools-augmentation>"]);
    expect(records).toEqual([
      { tag: toolsTag, built: false, reason: "tools-current" },
      { tag: augmentedTag, built: true, reason: "base-unlabelled" },
    ]);
  });

  it("memoizes one tools image per libc while augmenting different bases", async () => {
    const builds: CapturedBuild[] = [];
    const scope = runScope("/agent-libc-memo");
    const images = await createAgentImages({
      declaredBaseTag: "declared",
      providers: ["claude"],
      scope,
      detectLibc: async (base) => base === "declared" ? "musl" : "glibc",
      inputsLabel: async () => null,
      build: async (image, options) => {
        builds.push({
          tag: image.tag,
          identity: image.containerfile,
          options,
          recipe: await readFile(join(options.contextRoot!, "Containerfile"), "utf8"),
        });
      },
      log: () => {},
    });
    await images.augment("variant");
    await images.augment("another-variant");

    const toolsBuilds = builds.filter(
      (build) => build.identity === "<generated-agent-tools-download>",
    );
    expect(toolsBuilds.map((build) => build.tag)).toEqual([
      toolsImageTag(scope, "musl", agentToolsFingerprint(["claude"], "musl")),
      toolsImageTag(scope, "glibc", agentToolsFingerprint(["claude"], "glibc")),
    ]);
    expect(builds.filter(
      (build) => build.identity === "<generated-agent-tools-augmentation>",
    )).toHaveLength(3);
    expect(images.liveTags()).toEqual([
      toolsImageTag(scope, "musl", agentToolsFingerprint(["claude"], "musl")),
      toolsImageTag(scope, "glibc", agentToolsFingerprint(["claude"], "glibc")),
      ...images.builtTags(),
    ]);
  });

  it("deduplicates concurrent augmentation of the same base", async () => {
    let builds = 0;
    const images = await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope: runScope("/deduplicated-agent-image"),
      inputsLabel: async () => null,
      build: async () => { builds += 1; },
      log: () => {},
    });
    const [first, second, third] = await Promise.all([
      images.augment("variant"),
      images.augment("variant"),
      images.augment("variant"),
    ]);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(builds).toBe(3);
  });

  it("forwards a configured Codex home into the augmentation recipe", async () => {
    const codexHome = "/home/agent/codex's state";
    const recipes: string[] = [];
    await createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      codexHome,
      scope: runScope("/agent-images-codex-home"),
      inputsLabel: async () => null,
      build: async (image, options) => {
        if (image.containerfile === "<generated-agent-tools-augmentation>") {
          recipes.push(await readFile(join(options.contextRoot!, "Containerfile"), "utf8"));
        }
      },
      log: () => {},
    });
    expect(recipes[0]).toContain(
      "if [ ! -e '/home/agent/codex'\\''s state' ]; then " +
        "mkdir -p '/home/agent/codex'\\''s state'",
    );
    expect(recipes[0]).toContain(
      "chown 1000:$(id -g agent) '/home/agent/codex'\\''s state'",
    );
  });

  it("retries a tools build after a transient failure", async () => {
    const scope = runScope("/tools-retry");
    const glibcToolsTag = toolsImageTag(
      scope,
      "glibc",
      agentToolsFingerprint(["claude"], "glibc"),
    );
    let toolsAttempts = 0;
    const images = await createAgentImages({
      declaredBaseTag: "base",
      providers: ["claude"],
      scope,
      detectLibc: async (base) => base === "base" ? "glibc" : "musl",
      inputsLabel: async (tag) =>
        tag === glibcToolsTag
          ? agentToolsFingerprint(["claude"], "glibc")
          : null,
      build: async (image) => {
        if (image.containerfile === "<generated-agent-tools-download>") {
          toolsAttempts += 1;
          if (toolsAttempts === 1) throw new Error("registry unavailable");
        }
      },
      log: () => {},
    });
    await expect(images.augment("variant")).rejects.toThrow("registry unavailable");
    await expect(images.augment("variant")).resolves.toMatch(/^variant:sb-/);
    expect(toolsAttempts).toBe(2);
  });

  it("names the base and routed toolset when augmentation fails", async () => {
    await expect(createAgentImages({
      declaredBaseTag: "broken-base",
      providers: ["codex"],
      scope: runScope("/failed-agent-image"),
      inputsLabel: async () => null,
      build: async () => { throw new Error("registry unavailable"); },
      log: () => {},
    })).rejects.toThrow(
      `could not augment image 'broken-base' with agent tools codex: ${
        AGENT_PROVIDER_PACKAGES.codex.version
      }: registry unavailable`,
    );
  });

  it("changes the tools fingerprint for each independently pinned digest", () => {
    const baseline = agentToolsFingerprint(
      ["codex"], "glibc", { arch: "x64" },
    );
    const artifacts = AGENT_PROVIDER_PACKAGES.codex.artifacts.x64;
    for (const binary of [undefined, "codex-code-mode-host"] as const) {
      const changedPackages = {
        ...AGENT_PROVIDER_PACKAGES,
        codex: {
          ...AGENT_PROVIDER_PACKAGES.codex,
          artifacts: {
            ...AGENT_PROVIDER_PACKAGES.codex.artifacts,
            x64: artifacts.map((artifact) =>
              artifact.binary === binary
                ? { ...artifact, sha256: "f".repeat(64) }
                : artifact
            ),
          },
        },
      };
      expect(agentToolsFingerprint(["codex"], "glibc", {
        arch: "x64",
        packages: changedPackages,
      })).not.toBe(baseline);
    }
  });

  it("selects every provider binary and static artifacts before libc-specific ones", () => {
    const codex = AGENT_PROVIDER_PACKAGES.codex;
    const selected = selectedAgentArtifacts(codex, "x64", "glibc", "codex");
    expect(selected.map((artifact) => agentArtifactBinary("codex", artifact)))
      .toEqual(["codex", "codex-code-mode-host"]);
    expect(selected.map((artifact) => agentArtifactName("codex", artifact)))
      .toEqual(["codex-static", "codex-code-mode-host-static"]);
    expect(selectedAgentArtifact(codex, "x64", "glibc").binary).toBeUndefined();
    const artifact = AGENT_PROVIDER_PACKAGES.codex.artifacts.x64[0]!;
    const pin = {
      version: "test",
      artifacts: {
        x64: [artifact, { ...artifact, variant: "glibc" as const }],
        arm64: [artifact],
      },
    };
    expect(selectedAgentArtifact(pin, "x64", "glibc").variant).toBe("static");
  });

  it("rejects unsupported hosts and ambiguous artifact groups", () => {
    expect(() => hostAgentArchitecture("riscv64")).toThrow(/riscv64/);
    const artifact = AGENT_PROVIDER_PACKAGES.claude.artifacts.x64[0]!;
    const pin = {
      version: "test",
      artifacts: { x64: [artifact], arm64: [artifact] },
    };
    expect(() => selectedAgentArtifact(pin, "x64", "musl"))
      .toThrow(/0 x64-musl artifacts; expected exactly one/);
    expect(() => selectedAgentArtifacts({
      ...pin,
      artifacts: {
        ...pin.artifacts,
        x64: [artifact, { ...artifact, binary: "claude" }],
      },
    }, "x64", "glibc", "claude"))
      .toThrow(/two artifacts for one installed command/);
  });

  it("isolates the libc probe from image entrypoints and declared volumes", () => {
    expect(detectImageLibcArgv("app:dev")).toEqual([
      "run", "--rm", "--image-volume=ignore", "--entrypoint", "sh", "app:dev",
      "-c", "[ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]",
    ]);
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

  it("installs no agent CLI in the host image — the driver owns them", () => {
    const instructions = readFileSync(
      new URL("../Containerfile", import.meta.url), "utf8",
    ).split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    for (const provider of AGENT_PROVIDER_NAMES) {
      expect(instructions, provider).not.toContain(provider);
      for (const artifacts of Object.values(
        AGENT_PROVIDER_PACKAGES[provider].artifacts,
      )) {
        for (const artifact of artifacts) {
          expect(instructions, provider).not.toContain(artifact.url);
        }
      }
    }
  });

  it("has one spelling of the image record line", () => {
    expect(formatImageRecord({
      tag: "localhost/app:gate",
      built: true,
      reason: "inputs-changed",
      durationMs: 26400,
    })).toBe(
      "image localhost/app:gate built=true reason=inputs-changed durationMs=26400",
    );
  });
});
