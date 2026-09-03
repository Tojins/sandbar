import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  agentArtifactBinary,
  agentArtifactCacheRoot,
  agentArtifactName,
  buildArgv,
  createAgentImages,
  detectImageLibcArgv,
  findAgentBinary,
  formatImageRecord,
  hostAgentArchitecture,
  prepareAgentArtifacts,
  selectedAgentArtifact,
  selectedAgentArtifacts,
  sweepBranchImages,
} from "./ensure-images.js";
import { runScope, variantImageTag } from "./naming.js";

async function fakeAgentArtifacts(
  providers: readonly (typeof AGENT_PROVIDER_NAMES)[number][],
  libc: "glibc" | "musl",
): Promise<PreparedAgentArtifacts> {
  const root = await mkdtemp(join(tmpdir(), "sandbar-agent-tools-test-"));
  const sha256: Record<string, string> = {};
  const arch = process.arch as "x64" | "arm64";
  // EVERY binary the provider installs, named by the module's own rule (#120).
  // A second spelling of the naming rule here is what let this fixture drift
  // out from under the recipe: it staged one file while the Containerfile
  // beside it COPYed two, and only a stubbed `build` hid it.
  for (const provider of providers) {
    for (
      const artifact of selectedAgentArtifacts(
        AGENT_PROVIDER_PACKAGES[provider], arch, libc, provider,
      )
    ) {
      const name = agentArtifactName(provider, artifact);
      const content = `test ${name}`;
      await writeFile(join(root, name), content);
      sha256[name] = createHash("sha256").update(content).digest("hex");
    }
  }
  return {
    root,
    names: Object.keys(sha256),
    verify: async () => {
      for (const [name, expected] of Object.entries(sha256)) {
        const actual = createHash("sha256")
          .update(await readFile(join(root, name)))
          .digest("hex");
        if (actual !== expected) {
          throw new Error(
            `staged artifact ${name}/${process.arch} failed re-verification`,
          );
        }
      }
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

describe("run-owned agent images", () => {
  it("stages a tar context containing only the routed, pinned tools", async () => {
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
    expect(builds[0].files).toEqual([
      "Containerfile", "codex-code-mode-host-static", "codex-static",
    ]);
    expect(builds[0].content).toContain("COPY --chmod=0755 codex-static");
    expect(builds[0].content).not.toContain("claude");
    // The context must carry exactly what the recipe COPYs — the invariant the
    // per-file assertion above only samples. Stated over the generated recipe
    // so the next provider to grow a binary cannot pass with a short context.
    const copied = builds[0]!.content
      .split("\n")
      .filter((line) => line.startsWith("COPY "))
      .map((line) => line.split(/\s+/)[2]!);
    expect(copied.length).toBeGreaterThan(1);
    expect([...copied].sort()).toEqual(
      builds[0]!.files.filter((file) => file !== "Containerfile").sort(),
    );
  });

  // #82. The augment build happens on EVERY run since #75 — the end-of-run
  // cleanup drops the tag unconditionally, so the next startup finds it gone —
  // and its cost has never been measured on any run, because the last logged
  // run predates #75. The record is what makes it measurable, and it says
  // `built=true` rather than laundering a layer-cached build into "reused".
  it("records what the augment build did, and why", async () => {
    const records: Array<{ built: boolean; reason: string }> = [];
    await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["codex"],
      scope: runScope("/agent-images"),
      prepareArtifacts: fakeAgentArtifacts,
      inputsLabel: async (tag) => (tag === "localhost/app:base" ? "base-fp" : null),
      build: async () => {},
      log: () => {},
      onImage: (r) => {
        records.push({ built: r.built, reason: r.reason });
      },
    });
    expect(records).toEqual([{ built: true, reason: "variant-stale" }]);
  });

  it("records a base of unknown provenance as its own reason", async () => {
    const records: string[] = [];
    await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["codex"],
      scope: runScope("/agent-images"),
      prepareArtifacts: fakeAgentArtifacts,
      // Neither the base nor the variant carries a label.
      inputsLabel: async () => null,
      build: async () => {},
      log: () => {},
      onImage: (r) => {
        records.push(r.reason);
      },
    });
    expect(records).toEqual(["base-unlabelled"]);
  });

  it("records a current variant as reused, which is as load-bearing as built", async () => {
    // A 0.3 s startup and a 26 s one differ only in that word, so the line has
    // to exist in the fast case for the slow one to read as unusual.
    // codex's artifact is static on both architectures, so the recipe the run
    // fingerprints is the `glibc` one no libc probe was needed for.
    const containerfile = agentToolsContainerfile("localhost/app:base", ["codex"], {
      arch: hostAgentArchitecture(),
      libc: "glibc",
    });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["base-fp", containerfile]))
      .digest("hex");
    const records: Array<{ built: boolean; reason: string }> = [];
    let built = 0;
    await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["codex"],
      scope: runScope("/agent-images"),
      prepareArtifacts: fakeAgentArtifacts,
      inputsLabel: async (tag) =>
        tag === "localhost/app:base" ? "base-fp" : fingerprint,
      build: async () => {
        built++;
      },
      log: () => {},
      onImage: (r) => {
        records.push({ built: r.built, reason: r.reason });
      },
    });
    expect(built).toBe(0);
    expect(records).toEqual([{ built: false, reason: "variant-current" }]);
  });

  it("has one spelling of the record line", () => {
    expect(
      formatImageRecord({
        tag: "localhost/app:gate",
        built: true,
        reason: "inputs-changed",
        durationMs: 26400,
      }),
    ).toBe(
      "image localhost/app:gate built=true reason=inputs-changed durationMs=26400",
    );
  });

  it("links only the libc variant selected from the base image", async () => {
    let files: string[] = [];
    await createAgentImages({
      declaredBaseTag: "localhost/app:base",
      providers: ["claude"],
      scope: runScope("/agent-libc"),
      prepareArtifacts: fakeAgentArtifacts,
      detectLibc: async () => "musl",
      inputsLabel: async (tag) => tag === "localhost/app:base" ? "base-fp" : null,
      build: async (_image, opts) => {
        files = (await readdir(opts.contextRoot!)).sort();
        const recipe = await readFile(join(opts.contextRoot!, "Containerfile"), "utf8");
        expect(recipe).toContain("claude-musl /usr/local/bin/claude");
        expect(recipe).not.toContain("claude-glibc /usr/local/bin/claude");
      },
      log: () => {},
    });
    expect(files).toEqual(["Containerfile", "claude-musl"]);
  });

  it("prepares each libc variant once across different base images", async () => {
    const preparations: Array<"glibc" | "musl"> = [];
    const contextFiles: string[][] = [];
    const images = await createAgentImages({
      declaredBaseTag: "declared",
      providers: ["claude"],
      scope: runScope("/agent-libc-memo"),
      prepareArtifacts: async (providers, libc) => {
        preparations.push(libc);
        return fakeAgentArtifacts(providers, libc);
      },
      detectLibc: async (baseTag) => baseTag === "declared" ? "musl" : "glibc",
      inputsLabel: async () => null,
      build: async (_image, opts) => {
        contextFiles.push((await readdir(opts.contextRoot!)).sort());
      },
      log: () => {},
    });
    await images.augment("variant");
    await images.augment("another-variant");
    expect(preparations).toEqual(["musl", "glibc"]);
    expect(contextFiles).toEqual([
      ["Containerfile", "claude-musl"],
      ["Containerfile", "claude-glibc"],
      ["Containerfile", "claude-glibc"],
    ]);
  });

  it("copies and probes both standalone provider binaries", () => {
    const file = agentToolsContainerfile("base", ["claude", "codex"], {
      libc: "glibc",
    });
    expect(file).toContain("COPY --chmod=0755 claude-glibc /usr/local/bin/claude");
    expect(file).not.toContain("claude-musl /usr/local/bin/claude");
    expect(file).toContain("COPY --chmod=0755 codex-static /usr/local/bin/codex");
    expect(file).toContain(
      "claude --version && codex --version && " +
        "test -x /usr/local/bin/codex-code-mode-host && git --version",
    );
    expect(file).toContain("command -v git >/dev/null");
    expect(file).toContain("apt-get install -y --no-install-recommends git");
    expect(file).toContain("apk add --no-cache git");
    expect(file).toContain("dnf install -y git");
    expect(file).toContain("awk -F: '$3 == 1000");
    expect(file).toContain("useradd -u 1000 -m -d /home/agent agent");
    expect(file).toContain("adduser -D -u 1000 -h /home/agent agent");
    expect(file).toContain("chown -R 1000:$(id -g agent) /home/agent");
    expect(file).toContain('test "$(id -u agent)" = 1000');
    expect(file).toContain('test "$(stat -c %u /home/agent)" = 1000');
    for (const artifacts of Object.values(AGENT_PROVIDER_PACKAGES.claude.artifacts)) {
      for (const artifact of artifacts) expect(file).toContain(artifact.sha256);
    }
    expect(file).toContain(AGENT_PROVIDER_PACKAGES.codex.artifacts.arm64[0]!.sha256);
    expect(file).not.toContain("npm");
  });

  // The inverse of the guard this used to be. While the host Containerfile still
  // carried its own CLI installs, the test asserted the two pins AGREED; #75
  // made the driver append the routed providers after resolving the image, and
  // the pin move deleted the host copies — at which point an agreement test
  // asserts the opposite of the rule. The rule the Containerfile now states in
  // prose is "do not re-add a host copy": an unpinned one drifts from the
  // parser the driver couples to, and the driver's install
  // wins over it anyway, so the host copy is invisible until the day it is the
  // one that ran. Asserting the ABSENCE is what keeps that prose enforced.
  // Since #76 there is no npm spec to look for, so the terms are the provider's
  // own name and the pinned artifact URLs the driver alone downloads — read off
  // the instructions, since the prose above them names claude-code deliberately.
  it("installs no agent CLI in the host image — the driver owns them (#75, #76)", () => {
    const instructions = readFileSync(
      new URL("../Containerfile", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
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
      detectLibc: async () => "glibc",
      inputsLabel: async () => (++reads === 1 ? null : "apparently-present"),
      build: async () => {
        builds += 1;
      },
      log: () => {},
    });
    expect(builds).toBe(1);
  });

  it("reuses a derived image whose label matches a labelled base and toolset", async () => {
    const containerfile = agentToolsContainerfile("base", ["codex"], {
      libc: "glibc",
    });
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
      prepareArtifacts: async (providers, libc) => {
        artifactPreparations += 1;
        return fakeAgentArtifacts(providers, libc);
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
    let artifactPreparations = 0;
    let releaseBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const imagesPromise = createAgentImages({
      declaredBaseTag: "base",
      providers: ["codex"],
      scope: runScope("/deduplicated-agent-image"),
      prepareArtifacts: async (providers, libc) => {
        artifactPreparations += 1;
        return fakeAgentArtifacts(providers, libc);
      },
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
    expect(artifactPreparations).toBe(1);
  });

  it("selects extracted provider binaries and rejects unsupported hosts", () => {
    expect(findAgentBinary("codex", ["codex"])).toBe("codex");
    expect(findAgentBinary("codex", ["README", "codex-aarch64"])).toBe("codex-aarch64");
    expect(() => findAgentBinary("codex", ["README"])).toThrow(/no codex binary/);
    expect(() => hostAgentArchitecture("riscv64")).toThrow(/riscv64/);
  });

  // #120: `codex-` is a prefix of the code-mode host's own file name, so the
  // CLI's lookup must not be settled by readdir order. An exact hit still wins
  // over a longer sibling.
  it("refuses an ambiguous archive member and prefers an exact name", () => {
    const both = [
      "codex-x86_64-unknown-linux-musl",
      "codex-code-mode-host-x86_64-unknown-linux-musl",
    ];
    expect(() => findAgentBinary("codex", both))
      .toThrow(/2 candidates for the codex binary/);
    expect(findAgentBinary("codex-code-mode-host", both))
      .toBe("codex-code-mode-host-x86_64-unknown-linux-musl");
    expect(findAgentBinary("codex", ["codex", ...both])).toBe("codex");
  });

  // The helper is selected by the same static-else-libc rule as the CLI, and
  // grouping is what keeps the two from competing for "the" x64 artifact.
  it("installs every named binary a provider declares", () => {
    const codex = AGENT_PROVIDER_PACKAGES.codex;
    const selected = selectedAgentArtifacts(codex, "x64", "glibc");
    expect(selected.map((a) => agentArtifactBinary("codex", a)))
      .toEqual(["codex", "codex-code-mode-host"]);
    expect(selected.map((a) => agentArtifactName("codex", a)))
      .toEqual(["codex-static", "codex-code-mode-host-static"]);
    // The CLI's own artifact is still addressable as one thing.
    expect(selectedAgentArtifact(codex, "x64", "glibc").binary).toBeUndefined();
    const file = agentToolsContainerfile("base", ["codex"], { libc: "glibc" });
    expect(file).toContain(
      "COPY --chmod=0755 codex-code-mode-host-static " +
        "/usr/local/bin/codex-code-mode-host",
    );
  });

  it("selects static artifacts before libc-specific artifacts", () => {
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

  it("keeps recipe file names independent of the selected architecture", () => {
    const x64 = agentToolsContainerfile("base", ["claude", "codex"], {
      arch: "x64", libc: "glibc",
    });
    const arm64 = agentToolsContainerfile("base", ["claude", "codex"], {
      arch: "arm64", libc: "glibc",
    });
    const copyLines = (recipe: string) => recipe
      .split("\n")
      .filter((line) => line.startsWith("COPY "));
    expect(copyLines(x64)).toEqual(copyLines(arm64));
  });

  it("rejects missing and duplicate architecture/libc artifacts", () => {
    const artifact = AGENT_PROVIDER_PACKAGES.claude.artifacts.x64[0]!;
    const pin = {
      version: "test",
      artifacts: { x64: [artifact], arm64: [artifact] },
    };
    expect(() => selectedAgentArtifact(pin, "x64", "musl"))
      .toThrow(/0 x64-musl artifacts; expected exactly one/);
    expect(() => selectedAgentArtifact(
      { ...pin, artifacts: { ...pin.artifacts, x64: [artifact, artifact] } },
      "x64",
      "glibc",
    )).toThrow(/2 x64-glibc artifacts; expected exactly one/);
  });

  it("isolates the libc probe from image entrypoints and declared volumes", () => {
    expect(detectImageLibcArgv("app:dev")).toEqual([
      "run", "--rm", "--image-volume=ignore", "--entrypoint", "sh", "app:dev",
      "-c", "[ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]",
    ]);
  });

  it("scopes the default artifact cache to the host uid", () => {
    expect(agentArtifactCacheRoot(1234)).toBe(
      join(tmpdir(), "sandbar-agent-tools-1234"),
    );
    expect(() => agentArtifactCacheRoot(-1)).toThrow(/numeric host uid/);
  });

  // An EMPTY cache root, not the shared host one: these assertions are about
  // what a download does, and against `agentArtifactCacheRoot()` a machine that
  // has already run the driver serves every pinned artifact from cache, never
  // calls the stub, and rejects nothing.
  it("rejects non-OK and hash-mismatched pinned downloads", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-reject-cache-"));
    try {
      await expect(prepareAgentArtifacts(["codex"], () => {}, {
        arch: "x64",
        libc: "glibc",
        cacheRoot,
        fetch: async () => new Response("missing", { status: 503 }),
      })).rejects.toThrow(/HTTP 503/);
      await expect(prepareAgentArtifacts(["codex"], () => {}, {
        arch: "x64",
        libc: "glibc",
        cacheRoot,
        fetch: async () => new Response(null),
      })).rejects.toThrow(/empty response body/);
      await expect(prepareAgentArtifacts(["codex"], () => {}, {
        arch: "x64",
        libc: "glibc",
        cacheRoot,
        fetch: async () => new Response("not the pinned artifact"),
      })).rejects.toThrow(/sha256 mismatch/);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  // #120: two archives for one provider. Distinct shas so each gets its own
  // content-addressed cache entry, and distinct members so a swapped extraction
  // would show up as swapped content rather than as a passing test.
  it("stages every binary a provider installs, without collision", async () => {
    const cliBytes = "cli archive fixture";
    const hostBytes = "host archive fixture";
    const sha = (bytes: string) =>
      createHash("sha256").update(bytes).digest("hex");
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      codex: {
        version: "test",
        artifacts: {
          x64: [
            { variant: "static" as const, url: "cli", sha256: sha(cliBytes), archive: true as const },
            {
              variant: "static" as const,
              binary: "codex-code-mode-host",
              url: "host",
              sha256: sha(hostBytes),
              archive: true as const,
            },
          ],
          arm64: AGENT_PROVIDER_PACKAGES.codex.artifacts.arm64,
        },
      },
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-multi-cache-"));
    try {
      const prepared = await prepareAgentArtifacts(["codex"], () => {}, {
        arch: "x64",
        libc: "glibc",
        packages,
        cacheRoot,
        fetch: async (url) =>
          new Response(url === "cli" ? cliBytes : hostBytes),
        extract: async (archive, destination) => {
          const bytes = await readFile(archive, "utf8");
          const member = bytes === cliBytes
            ? "codex-x86_64-unknown-linux-musl"
            : "codex-code-mode-host-x86_64-unknown-linux-musl";
          await writeFile(join(destination, member), `binary:${bytes}`);
        },
      });
      await prepared.verify();
      expect([...prepared.names].sort())
        .toEqual(["codex-code-mode-host-static", "codex-static"]);
      expect(await readFile(join(prepared.root, "codex-static"), "utf8"))
        .toBe(`binary:${cliBytes}`);
      expect(
        await readFile(join(prepared.root, "codex-code-mode-host-static"), "utf8"),
      ).toBe(`binary:${hostBytes}`);
      // Two cache entries, one per digest — neither artifact evicted the other.
      expect((await readdir(cacheRoot)).sort())
        .toEqual([sha(cliBytes), sha(hostBytes)].sort());
      await prepared.dispose();
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  // A `binary` repeating the provider's own name resolves to one staged file
  // and one COPY target for two artifacts — the silent wrong-binary install the
  // grouping argument depends on being impossible.
  it("refuses an artifact whose binary repeats the provider's own name", () => {
    const artifact = AGENT_PROVIDER_PACKAGES.codex.artifacts.x64[0]!;
    const pin = {
      version: "test",
      artifacts: {
        x64: [artifact, { ...artifact, binary: "codex" }],
        arm64: AGENT_PROVIDER_PACKAGES.codex.artifacts.arm64,
      },
    };
    expect(() => selectedAgentArtifacts(pin, "x64", "glibc", "codex"))
      .toThrow(/two artifacts for one installed command/);
  });

  it("extracts, discovers, verifies, and disposes an archived pinned tool", async () => {
    const bytes = "tiny archive fixture";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      codex: {
        version: "test",
        artifacts: {
          x64: [{ variant: "static" as const, url: "fixture", sha256, archive: true as const }],
          arm64: [{ variant: "static" as const, url: "fixture", sha256, archive: true as const }],
        },
      },
    };
    const prepared = await prepareAgentArtifacts(["codex"], () => {}, {
      arch: "x64",
      libc: "glibc",
      packages,
      fetch: async () => new Response(bytes),
      extract: async (_archive, destination) => {
        await writeFile(join(destination, "codex-x86_64-unknown-linux-musl"), "binary");
      },
    });
    await prepared.verify();
    expect(prepared.names).toEqual(["codex-static"]);
    expect(await readdir(prepared.root)).toEqual(["codex-static"]);
    expect(await readFile(join(prepared.root, "codex-static"), "utf8")).toBe("binary");
    await prepared.dispose();
    await expect(readdir(prepared.root)).rejects.toThrow();
  });

  it("stages and re-verifies a direct standalone download", async () => {
    const bytes = "standalone claude fixture";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      claude: {
        version: "test",
        artifacts: {
          x64: [{ variant: "static" as const, url: "fixture", sha256 }],
          arm64: [{ variant: "static" as const, url: "fixture", sha256 }],
        },
      },
    };
    const prepared = await prepareAgentArtifacts(["claude"], () => {}, {
      arch: "x64",
      libc: "glibc",
      packages,
      fetch: async () => new Response(bytes),
    });
    expect(await readFile(join(prepared.root, "claude-static"), "utf8")).toBe(bytes);
    await prepared.verify();
    await writeFile(join(prepared.root, "claude-static"), "mutated");
    await expect(prepared.verify()).rejects.toThrow(
      /staged artifact claude-static\/x64 failed re-verification/,
    );
    await prepared.dispose();
  });

  it("downloads and stages only the selected libc variant", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-libc-cache-"));
    const glibc = "glibc fixture";
    const musl = "musl fixture";
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      claude: {
        version: "test",
        artifacts: {
          x64: [
            { variant: "glibc" as const, url: "glibc", sha256: createHash("sha256").update(glibc).digest("hex") },
            { variant: "musl" as const, url: "musl", sha256: createHash("sha256").update(musl).digest("hex") },
          ],
          arm64: AGENT_PROVIDER_PACKAGES.claude.artifacts.arm64,
        },
      },
    };
    const fetched: string[] = [];
    try {
      const prepared = await prepareAgentArtifacts(["claude"], () => {}, {
        arch: "x64", packages, libc: "musl", cacheRoot,
        fetch: async (url) => {
          fetched.push(String(url));
          return new Response(musl);
        },
      });
      expect(fetched).toEqual(["musl"]);
      expect(prepared.names).toEqual(["claude-musl"]);
      expect(await readdir(prepared.root)).toEqual(["claude-musl"]);
      await prepared.dispose();
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("reuses a sha-addressed download across staging lifetimes", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-cache-test-"));
    const bytes = "persistent standalone fixture";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      codex: {
        version: "test",
        artifacts: {
          x64: [{ variant: "static" as const, url: "fixture", sha256 }],
          arm64: [{ variant: "static" as const, url: "fixture", sha256 }],
        },
      },
    };
    let fetches = 0;
    const adapters = {
      arch: "x64",
      cacheRoot,
      packages,
      libc: "glibc",
      fetch: async () => {
        fetches += 1;
        return new Response(bytes);
      },
    } as const;
    try {
      const first = await prepareAgentArtifacts(["codex"], () => {}, adapters);
      await first.dispose();
      const second = await prepareAgentArtifacts(["codex"], () => {}, adapters);
      await second.verify();
      await second.dispose();
      expect(fetches).toBe(1);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("stages one cached artifact concurrently without sharing a partial file", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-cache-race-"));
    const bytes = "concurrent standalone fixture";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      codex: {
        version: "test",
        artifacts: {
          x64: [{ variant: "static" as const, url: "fixture", sha256 }],
          arm64: [{ variant: "static" as const, url: "fixture", sha256 }],
        },
      },
    };
    const adapters = {
      arch: "x64",
      cacheRoot,
      packages,
      libc: "glibc",
      fetch: async () => new Response(bytes),
    } as const;
    try {
      const [first, second] = await Promise.all([
        prepareAgentArtifacts(["codex"], () => {}, adapters),
        prepareAgentArtifacts(["codex"], () => {}, adapters),
      ]);
      await Promise.all([first.verify(), second.verify()]);
      await Promise.all([first.dispose(), second.dispose()]);
      expect(await readdir(join(cacheRoot, sha256))).toEqual(["download"]);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("replaces a corrupted sha-addressed cache entry", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-cache-corrupt-"));
    const bytes = "pinned standalone fixture";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      codex: {
        version: "test",
        artifacts: {
          x64: [{ variant: "static" as const, url: "fixture", sha256 }],
          arm64: [{ variant: "static" as const, url: "fixture", sha256 }],
        },
      },
    };
    const artifactRoot = join(cacheRoot, sha256);
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(artifactRoot, "download"), "corrupted cache entry");
    let fetches = 0;
    try {
      const prepared = await prepareAgentArtifacts(["codex"], () => {}, {
        arch: "x64", cacheRoot, packages, libc: "glibc",
        fetch: async () => {
          fetches += 1;
          return new Response(bytes);
        },
      });
      await prepared.verify();
      expect(fetches).toBe(1);
      expect(await readFile(join(artifactRoot, "download"), "utf8")).toBe(bytes);
      await prepared.dispose();
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("removes a partial cache entry when a download stream fails", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-cache-failure-"));
    const sha256 = "a".repeat(64);
    const packages = {
      ...AGENT_PROVIDER_PACKAGES,
      codex: {
        version: "test",
        artifacts: {
          x64: [{ variant: "static" as const, url: "fixture", sha256 }],
          arm64: [{ variant: "static" as const, url: "fixture", sha256 }],
        },
      },
    };
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection reset"));
      },
    });
    try {
      await expect(prepareAgentArtifacts(["codex"], () => {}, {
        arch: "x64", cacheRoot, packages, libc: "glibc",
        fetch: async () => new Response(body),
      })).rejects.toThrow(/connection reset/);
      expect(await readdir(join(cacheRoot, sha256))).toEqual([]);
      expect((await stat(cacheRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("re-verifies staged tools before augmenting a later variant", async () => {
    const artifacts = await fakeAgentArtifacts(["codex"], "glibc");
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
      /staged artifact codex-static\/.+ failed re-verification/,
    );
  });

  it("retries artifact staging after a transient failure", async () => {
    const containerfile = agentToolsContainerfile("base", ["codex"], {
      libc: "glibc",
    });
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
      prepareArtifacts: async (providers, libc) => {
        preparations += 1;
        if (preparations === 1) throw new Error("transient CDN failure");
        return fakeAgentArtifacts(providers, libc);
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
