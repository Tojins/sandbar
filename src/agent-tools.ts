// Driver-owned agent tool images and sandbox image resolution (#46, #75, #76).
//
// The branch owns the environment; the run owns the tools. Provider pins live
// in agent-providers.ts and are content addresses: every host download is
// checksum-verified before use, and codex's pin moves with its JSONL parser. A
// provider may install sibling binaries such as codex-code-mode-host from that
// same pin (#120).
//
// Large artifacts are cached across runs and workdirs beneath the host temp
// directory, keyed by their driver-owned digest and re-hashed on every reuse.
// This reproducible cache is deliberately not swept and is the sole exception
// to sandbar state living beneath <cwd>/<workDir>: concurrent runs may share it
// without racing a pin change.
//
// Dynamic releases require a libc choice, so augmentation probes the resolved
// base with an entrypoint-neutral podman run. Only an explicit, unsignalled
// exit 0 is an answer (#119): podman can trap a timeout signal and itself exit
// cleanly even when no container started. Bases need only /bin/sh, CA roots,
// and git or apt/apk/dnf; the generated layer supplies git, uid 1000, and each
// standalone CLI, then probes every installed binary. Bare CLI probes cannot
// prove their embedded trust stores, so CA roots remain a base requirement.
//
// Sandbox resolution is deliberately softer than gate image resolution (#46).
// A branch-image build failure falls back to the augmented declared image so
// the agent that must repair a broken recipe can still start. Failure while
// appending tools falls back to that same known-good augmented image. Both paths
// report the stale-environment cost; no unaugmented image can reach an agent.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  AGENT_PROVIDER_PACKAGES,
  type AgentArtifact,
  type AgentProviderName,
  type AgentProviderPackage,
} from "./agent-providers.js";
import { onCleanup, registerDisposable } from "./cleanup.js";
import type { BuiltImage } from "./config.js";
import { SandbarError } from "./errors.js";
import {
  IMAGE_QUERY_TIMEOUT_MS,
  type BranchImages,
  type BuildOptions,
  type ImageRecorder,
  buildImage,
  readInputsLabel,
} from "./ensure-images.js";
import { type RunScope, variantImageTag } from "./naming.js";
import { RUNTIME } from "./runtime.js";
import { startTimer } from "./timing.js";

const exec = promisify(execFile);

// Standalone agent releases are large enough to need a generous transfer
// window, but staging happens while the run owns the single-instance lock. A
// trickling or stalled CDN response must therefore have a total deadline just
// like the augment build it replaced.
export const AGENT_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 45 * 60_000;

// A provider installs one or more BINARIES, not one file (#120). A CLI that
// execs a sibling it resolves for itself — codex's code-mode host — is that
// sibling's only caller, so it belongs to the same run-owned pin and digest
// verification. Artifacts are grouped by `binary` and selected per group, so a
// helper and its CLI never compete for "the" artifact of an architecture, and
// every staged name is keyed on the installed command rather than the provider.

export function agentToolsetSpec(
  providers: readonly AgentProviderName[],
): string {
  return providers
    .map((provider) => `${provider}: ${AGENT_PROVIDER_PACKAGES[provider].version}`)
    .join(", ");
}

export function agentToolsContainerfile(
  baseTag: string,
  providers: readonly AgentProviderName[],
  options: {
    readonly arch?: "x64" | "arm64";
    readonly packages?: typeof AGENT_PROVIDER_PACKAGES;
    readonly libc: "glibc" | "musl";
  },
): string {
  const arch = options.arch ?? hostAgentArchitecture();
  const packages = options.packages ?? AGENT_PROVIDER_PACKAGES;
  const libc = options.libc;
  const pins = providers.map((provider) => {
    const pin = packages[provider];
    const digests = (["x64", "arm64"] as const).flatMap((arch) =>
      pin.artifacts[arch].map((artifact) =>
        `${arch}-${agentArtifactName(provider, artifact)}:${artifact.sha256}`,
      ),
    );
    return `# ${provider} ${pin.version} ${digests.join(" ")}`;
  }).join("\n");
  const installed = providers.flatMap((provider) =>
    selectedAgentArtifacts(packages[provider], arch, libc, provider)
      .map((artifact) => ({
        provider,
        artifact,
        binary: agentArtifactBinary(provider, artifact),
      })),
  );
  const copies = installed.map(({ provider, artifact, binary }) =>
    `COPY --chmod=0755 ${agentArtifactName(provider, artifact)} /usr/local/bin/${binary}`,
  ).join("\n");
  // The CLI answers `--version`; a helper is a server with no such flag
  // (`codex-code-mode-host` speaks stdio/gRPC and rejects one), so it is probed
  // for presence and the executable bit instead — which is the whole of what
  // the image owes it, since the CLI is what execs it.
  const probes = installed
    .map(({ provider, binary }) =>
      binary === provider ? `${binary} --version` : `test -x /usr/local/bin/${binary}`,
    )
    .join(" && ");
  const gitClause = [
    "command -v git >/dev/null ||",
    "if command -v apt-get >/dev/null; then",
    "apt-get update && apt-get install -y --no-install-recommends git &&",
    "rm -rf /var/lib/apt/lists/*;",
    "elif command -v apk >/dev/null; then apk add --no-cache git;",
    "elif command -v dnf >/dev/null; then dnf install -y git && dnf clean all;",
    "else echo 'git is missing and no supported package manager (apt-get, apk, dnf) is available' >&2; exit 1; fi",
  ].join(" ");
  const agentUserClause = [
    "uid_user=$(awk -F: '$3 == 1000 { print $1; exit }' /etc/passwd);",
    'if [ -n "$uid_user" ] && [ "$uid_user" != agent ]; then',
    'sed -i "s/^$uid_user:/agent:/" /etc/passwd; fi;',
    "if ! id agent >/dev/null 2>&1; then",
    "if command -v useradd >/dev/null; then",
    "useradd -u 1000 -m -d /home/agent agent;",
    "else adduser -D -u 1000 -h /home/agent agent; fi; fi;",
    "mkdir -p /home/agent && chown -R 1000:$(id -g agent) /home/agent",
  ].join(" ");
  const probeClause = [
    probes,
    "git --version",
    'test "$(id -u agent)" = 1000',
    'test "$(stat -c %u /home/agent)" = 1000',
  ].join(" && ");
  return [
    `FROM ${baseTag}`,
    pins,
    "USER 0",
    `RUN ${gitClause}`,
    `RUN ${agentUserClause}`,
    copies,
    `RUN ${probeClause}`,
    "",
  ].join("\n");
}

export type PreparedAgentArtifacts = {
  readonly root: string;
  readonly names: readonly string[];
  readonly verify: () => Promise<void>;
  readonly dispose: () => Promise<void>;
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function hostAgentArchitecture(arch: string = process.arch): "x64" | "arm64" {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new SandbarError(
    `agent tools have no pinned artifact for host architecture '${arch}'`,
  );
}

// The CLI's OWN artifact — the one whose `binary` is absent. This answers about
// the CLI ALONE, so it is the wrong question for anything deciding on behalf of
// everything installed (the libc probe asks `selectedAgentArtifacts`); what is
// left is the callers that genuinely mean the agent binary itself.
export function selectedAgentArtifact(
  pin: AgentProviderPackage,
  arch: "x64" | "arm64",
  libc: "glibc" | "musl",
): AgentArtifact {
  return selectAgentArtifact(
    pin.artifacts[arch].filter((artifact) => artifact.binary === undefined),
    arch,
    libc,
    undefined,
  );
}

// Every binary the provider installs, the CLI first and its named siblings
// after, in declaration order (#120). Grouped by `binary` so a helper is
// selected by the SAME static-else-libc rule as the CLI and can never be
// mistaken for a competing variant of it.
export function selectedAgentArtifacts(
  pin: AgentProviderPackage,
  arch: "x64" | "arm64",
  libc: "glibc" | "musl",
  provider: AgentProviderName,
): readonly AgentArtifact[] {
  const groups = new Map<string | undefined, AgentArtifact[]>();
  for (const artifact of pin.artifacts[arch]) {
    const group = groups.get(artifact.binary);
    if (group) group.push(artifact);
    else groups.set(artifact.binary, [artifact]);
  }
  const selected = [...groups.entries()].map(
    ([binary, group]) => selectAgentArtifact(group, arch, libc, binary),
  );
  // `binary` naming the provider's own command would split into a second group
  // that resolves to the SAME staged file, COPY target and `names` entry as the
  // CLI — one destination, last write wins, a silently wrong install. Data this
  // module owns, so a guard rather than a type, but the grouping argument above
  // is only true while it holds.
  const names = selected.map(
    (artifact) => agentArtifactBinary(provider, artifact),
  );
  if (new Set(names).size !== names.length) {
    throw new SandbarError(
      `${provider} declares two artifacts for one installed command ` +
        `(${names.join(", ")}); a helper's \`binary\` must not repeat the ` +
        "provider's own name",
    );
  }
  return selected;
}

function selectAgentArtifact(
  candidates: readonly AgentArtifact[],
  arch: "x64" | "arm64",
  libc: "glibc" | "musl",
  binary: string | undefined,
): AgentArtifact {
  const staticArtifacts = candidates.filter(
    (artifact) => artifact.variant === "static",
  );
  const selected = staticArtifacts.length > 0
    ? staticArtifacts
    : candidates.filter((artifact) => artifact.variant === libc);
  if (selected.length !== 1) {
    throw new SandbarError(
      `agent provider has ${selected.length} ${arch}-${libc} ` +
        `${binary === undefined ? "artifacts" : `${binary} artifacts`}; ` +
        "expected exactly one",
    );
  }
  return selected[0]!;
}

// Keyed on the INSTALLED COMMAND, so a provider's helper stages beside its CLI
// instead of colliding with it (#120). Unchanged for every artifact without a
// `binary`: `claude-glibc`, `codex-static`.
export function agentArtifactName(
  provider: AgentProviderName,
  artifact: AgentArtifact,
): string {
  return `${agentArtifactBinary(provider, artifact)}-${artifact.variant}`;
}

// The command an artifact installs: its own name, or the provider's.
export function agentArtifactBinary(
  provider: AgentProviderName,
  artifact: AgentArtifact,
): string {
  return artifact.binary ?? provider;
}

// Which member of an extracted archive IS the binary. Release tarballs name the
// file for the target triple (`codex-x86_64-unknown-linux-musl`), so an exact
// match is tried first and a prefix match second — and an AMBIGUOUS prefix is
// refused rather than resolved by readdir order (#120): `codex-` matches
// `codex-code-mode-host-<triple>` too, and picking the wrong one would install
// a gRPC server as the agent CLI and only fail once an issue was in flight.
export function findAgentBinary(
  binary: string,
  entries: readonly string[],
): string {
  if (entries.includes(binary)) return binary;
  const prefixed = entries.filter((name) => name.startsWith(`${binary}-`));
  if (prefixed.length > 1) {
    throw new Error(
      `archive contains ${prefixed.length} candidates for the ${binary} ` +
        `binary (${prefixed.join(", ")}); expected exactly one`,
    );
  }
  const found = prefixed[0];
  if (!found) throw new Error(`archive contains no ${binary} binary`);
  return found;
}

export function detectImageLibcArgv(baseTag: string): string[] {
  return [
    "run", "--rm", "--image-volume=ignore", "--entrypoint", "sh", baseTag,
    "-c", "[ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]",
  ];
}

export async function detectImageLibc(baseTag: string): Promise<"glibc" | "musl"> {
  try {
    const probe = exec(RUNTIME, detectImageLibcArgv(baseTag), {
      timeout: IMAGE_QUERY_TIMEOUT_MS,
    });
    await probe;
    const { exitCode, killed, signalCode } = probe.child;
    if (exitCode !== 0 || killed || signalCode !== null) {
      throw new Error(
        `libc probe did not exit cleanly ` +
          `(exit=${exitCode ?? "none"}, signal=${signalCode ?? "none"}, killed=${killed})`,
      );
    }
    return "musl";
  } catch (err) {
    const exitCode = (err as { code?: unknown }).code;
    if (exitCode === 1) {
      return "glibc";
    }
    throw err;
  }
}

export type ArtifactPreparationAdapters = {
  readonly arch?: string;
  readonly fetch?: typeof fetch;
  readonly extract?: (archive: string, destination: string) => Promise<void>;
  readonly packages?: typeof AGENT_PROVIDER_PACKAGES;
  readonly cacheRoot?: string;
  readonly libc: "glibc" | "musl";
};

export function agentArtifactCacheRoot(
  uid: number | undefined = process.getuid?.(),
): string {
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw new SandbarError("agent artifact caching requires a numeric host uid");
  }
  return join(tmpdir(), `sandbar-agent-tools-${uid}`);
}

export async function prepareAgentArtifacts(
  providers: readonly AgentProviderName[],
  log: (line: string) => void,
  adapters: ArtifactPreparationAdapters,
): Promise<PreparedAgentArtifacts> {
  const arch = hostAgentArchitecture(adapters.arch);
  const fetchArtifact = adapters.fetch ?? fetch;
  const packages = adapters.packages ?? AGENT_PROVIDER_PACKAGES;
  const libc = adapters.libc;
  const extract = adapters.extract ?? (async (archive, destination) => {
    await exec("tar", ["-xzf", archive, "-C", destination]);
  });
  const cacheRoot = adapters.cacheRoot ?? agentArtifactCacheRoot();
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  // A disposable view gives callers the old flat file layout while the large
  // verified bytes live in a persistent, content-addressed cache across runs.
  const root = await mkdtemp(join(tmpdir(), "sandbar-agent-tools-view-"));
  const stagedSha256: Record<string, string> = {};
  try {
    for (const provider of providers) {
      for (
        const artifact of selectedAgentArtifacts(packages[provider], arch, libc, provider)
      ) {
        const binary = agentArtifactBinary(provider, artifact);
        const name = agentArtifactName(provider, artifact);
        const artifactRoot = join(cacheRoot, artifact.sha256);
        const downloaded = join(artifactRoot, "download");
        await mkdir(artifactRoot, { recursive: true });
        const identity = `${binary}/${arch}-${artifact.variant} from ${artifact.url}`;
        try {
          let cached = false;
          try {
            cached = await sha256File(downloaded) === artifact.sha256;
          } catch {
            // Missing and interrupted cache entries are ordinary cold misses.
          }
          if (!cached) {
            log(`Downloading agent tool ${identity}...`);
            // Two base variants can prepare the same static artifact concurrently
            // in one process. Give each transfer its own directory: a PID-only
            // name lets one successful rename remove the other's open path.
            const partialRoot = await mkdtemp(
              join(artifactRoot, `download-${process.pid}-`),
            );
            const partial = join(partialRoot, "download.partial");
            try {
              const response = await fetchArtifact(artifact.url, {
                signal: AbortSignal.timeout(AGENT_ARTIFACT_DOWNLOAD_TIMEOUT_MS),
              });
              if (!response.ok) {
                throw new Error(`download returned HTTP ${response.status}`);
              }
              if (response.body === null) {
                throw new Error("download returned an empty response body");
              }
              await pipeline(
                Readable.fromWeb(response.body as never),
                createWriteStream(partial),
              );
              const actual = await sha256File(partial);
              if (actual !== artifact.sha256) {
                throw new Error(
                  `sha256 mismatch (expected ${artifact.sha256}, got ${actual})`,
                );
              }
              await rename(partial, downloaded);
            } finally {
              await rm(partialRoot, { recursive: true, force: true });
            }
          }
          const destination = join(root, name);
          if (artifact.archive) {
            // The archive digest is pinned; the extracted bytes are not. Derive
            // them afresh from the verified cache instead of trusting a prior
            // run's executable as though it were content-addressed itself.
            const extractRoot = await mkdtemp(join(root, `${binary}-extracted-`));
            await extract(downloaded, extractRoot);
            const member = findAgentBinary(binary, await readdir(extractRoot));
            await rename(join(extractRoot, member), destination);
            await rm(extractRoot, { recursive: true, force: true });
          } else {
            await copyFile(downloaded, destination);
          }
          stagedSha256[name] = await sha256File(destination);
        } catch (err) {
          throw new Error(
            `could not download and stage ${identity}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }
    }
    return {
      root,
      names: Object.keys(stagedSha256),
      verify: async () => {
        for (const [name, expected] of Object.entries(stagedSha256)) {
          const actual = await sha256File(join(root, name));
          if (actual !== expected) {
            throw new Error(
              `staged artifact ${name}/${arch} failed re-verification ` +
                `(expected ${expected}, got ${actual})`,
            );
          }
        }
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

export type AgentImages = {
  readonly declaredTag: string;
  readonly augment: (baseTag: string) => Promise<string>;
  readonly builtTags: () => readonly string[];
};

export async function createAgentImages(opts: {
  readonly declaredBaseTag: string;
  readonly providers: readonly AgentProviderName[];
  readonly scope: RunScope;
  readonly build?: (image: BuiltImage, opts: BuildOptions) => Promise<unknown>;
  readonly inputsLabel?: (tag: string) => Promise<string | null>;
  readonly log?: (line: string) => void;
  readonly onImage?: ImageRecorder;
  readonly prepareArtifacts?: (
    providers: readonly AgentProviderName[],
    libc: "glibc" | "musl",
  ) => Promise<PreparedAgentArtifacts>;
  readonly detectLibc?: (baseTag: string) => Promise<"glibc" | "musl">;
}): Promise<AgentImages> {
  const build = opts.build ?? buildImage;
  const inputsLabel = opts.inputsLabel ?? readInputsLabel;
  const log = opts.log ?? ((line: string) => console.log(line));
  const toolset = agentToolsetSpec(opts.providers);
  const arch = hostAgentArchitecture();
  // Over EVERY binary a provider installs, not just its CLI (#120). What this
  // decides is whether the base is probed at all, and a false skips the probe
  // and hard-codes `glibc` for the whole selection — so a helper with
  // libc-specific variants under a static CLI would be staged glibc into a musl
  // image, silently. Asking the singular question here would be asking about
  // the CLI and answering for the set.
  const installedVariants = (
    provider: AgentProviderName,
    libc: "glibc" | "musl",
  ): string =>
    selectedAgentArtifacts(AGENT_PROVIDER_PACKAGES[provider], arch, libc, provider)
      .map((artifact) => artifact.variant)
      .join(",");
  const needsLibcChoice = opts.providers.some((provider) =>
    installedVariants(provider, "glibc") !== installedVariants(provider, "musl")
  );
  const pending = new Map<string, Promise<string>>();
  const order: string[] = [];
  const artifactPromises = new Map<"glibc" | "musl", Promise<PreparedAgentArtifacts>>();

  const artifacts = (libc: "glibc" | "musl"): Promise<PreparedAgentArtifacts> => {
    let promise = artifactPromises.get(libc);
    if (promise === undefined) {
      promise = (
        opts.prepareArtifacts !== undefined
          ? opts.prepareArtifacts(opts.providers, libc)
          : prepareAgentArtifacts(opts.providers, log, {
            libc,
          })
      ).then((prepared) => {
        onCleanup(prepared.dispose);
        return prepared;
      }).catch((err) => {
        artifactPromises.delete(libc);
        throw err;
      });
      artifactPromises.set(libc, promise);
    }
    return promise;
  };

  const augment = async (baseTag: string): Promise<string> => {
    let promise = pending.get(baseTag);
    if (promise === undefined) {
      promise = (async () => {
        const elapsed = startTimer();
        const baseInputs = await inputsLabel(baseTag);
        const libc = needsLibcChoice
          ? await (opts.detectLibc ?? detectImageLibc)(baseTag)
          : "glibc";
        const containerfile = agentToolsContainerfile(baseTag, opts.providers, {
          arch, libc,
        });
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([baseInputs ?? "unknown", containerfile]))
          .digest("hex");
        const tag = variantImageTag(baseTag, opts.scope, fingerprint);
        // An unlabelled base has unknown provenance. Its derived tag can be a
        // cache hint, never proof, so rebuild it and let podman's layer cache
        // make the common case cheap.
        // Since #75 this invokes a build on EVERY run — the end-of-run cleanup
        // removes the tag unconditionally, so the next startup finds it gone —
        // and the honest line says `built=true`. Whether podman's layer cache
        // made that cheap is what `durationMs` is for; papering it over as
        // "reused" would hide the one number that decides whether the
        // unconditional `order.push` below deserves its own issue (#82).
        if (baseInputs === null || (await inputsLabel(tag)) !== fingerprint) {
          log(
            `Augmenting '${baseTag}' as '${tag}' with agent tools ` +
              `${toolset}...`,
          );
          const contextRoot = await mkdtemp(
            join(tmpdir(), "sandbar-agent-context-"),
          );
          const withdrawContextCleanup = registerDisposable(
            () => rm(contextRoot, { recursive: true, force: true }),
          );
          try {
            const prepared = await artifacts(libc);
            await writeFile(join(contextRoot, "Containerfile"), containerfile);
            await prepared.verify();
            for (const name of prepared.names) {
              await link(join(prepared.root, name), join(contextRoot, name));
            }
            await build(
              { tag, containerfile: "<generated-agent-tools>" },
              { root: "", contextRoot, fingerprint, capture: true },
            );
          } finally {
            await rm(contextRoot, { recursive: true, force: true });
            withdrawContextCleanup();
          }
          await opts.onImage?.({
            tag,
            built: true,
            reason: baseInputs === null ? "base-unlabelled" : "variant-stale",
            durationMs: elapsed(),
          });
        } else {
          await opts.onImage?.({
            tag,
            built: false,
            reason: "variant-current",
            durationMs: elapsed(),
          });
        }
        order.push(tag);
        return tag;
      })().catch((err: unknown) => {
        pending.delete(baseTag);
        throw new SandbarError(
          `could not augment image '${baseTag}' with agent tools ` +
            `${toolset}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      });
      pending.set(baseTag, promise);
    }
    return promise;
  };

  const declaredTag = await augment(opts.declaredBaseTag);
  return { declaredTag, augment, builtTags: () => [...order] };
}

// ---------------------------------------------------------------------------
// The agent sandbox's image (#46)
// ---------------------------------------------------------------------------
// #37 left the sandbox out of the per-branch resolution on the grounds that its
// image "is resolved once, when the sandbox is created, before the branch it
// would be a function of exists". The first half is true and the second is not:
// `inner-loop.ts` prepares the issue worktree BEFORE it creates the sandbox
// (#20, for the stack's mounts), so at that point the branch's files are on
// disk, which is all a fingerprint needs.
//
// What the gap cost is not hypothetical — it is a consumer shell script that
// compares lockfiles against copies kept in the image and re-installs at boot,
// per package manager: image cache invalidation, re-implemented at run time
// because the config could not express it. A stale baked dependency inside the
// sandbox does not produce a false VERDICT (the gate resolves its own images),
// but it reads to the agent as a bug in the code it is being asked to fix.
//
// Two things are deliberately narrower than the gate's version:
//
//   - It resolves ONCE PER SANDBOX, not per attempt. The ralph loop's whole
//     shape is attempts accumulating in one container, so re-resolving mid-issue
//     would mean disposing the sandbox the agent is working in — and the agent
//     can install into its own sandbox with a command, which is a cost of one
//     turn against the certainty of losing its state. What the branch adds
//     during the run still reaches the GATE, per gate run, which is where
//     verdicts come from.
//
//   - A failed build FALLS BACK to the declared tag rather than throwing, and
//     this is the load-bearing half. The sandbox is where the fix gets written:
//     an agent that commits a lockfile which does not install would otherwise
//     make every later sandbox for that branch fail to start — including the
//     ones whose entire purpose is to repair it — and the branch outlives the
//     cycle, so a resumable issue would be wedged rather than merely red. The
//     agent's environment is then one commit stale, which is exactly the
//     pre-#46 state and is recoverable from inside the sandbox.
//
// What that fallback COSTS depends on whether a gate container runs the same
// tag, and the report must not guess. Where it does — sandbar's own config
// gives one image both roles — the gate resolves the entry itself, reds with
// the same build output and blames the branch, so this line is a warning about
// a verdict already on its way. Where the entry is the SANDBOX'S ALONE, which
// is the configuration this feature exists to serve and the one the README's
// example writes, no gate run ever resolves it: `startStack` asks only about
// the images its own spec names. The gate then goes green on images that built
// fine and this line is the only report the failure ever gets. Telling that
// operator to wait for a gate red would send them to watch for something that
// cannot arrive, so `gateRunsSameImage` is a required parameter rather than an
// assumption the message makes on their behalf.
//
// Appending the run-owned tools can fail after the branch variant itself built.
// That also falls back, but specifically to the augmented declared tag: startup
// either produced it or refused the run, so an unaugmented image can never
// reach an agent. The gate still runs the successfully built branch variant and
// cannot reproduce this augmentation failure, making this report the only one
// the operator gets; it must name both that fact and the same stale-environment
// cost as the branch-build fallback.
//
// The fallback is reported rather than swallowed: `onFallback` reaches the run
// log and the operator's console at the call site.
export async function resolveSandboxImage(opts: {
  readonly declaredTag: string;
  // Required because no image may reach an agent without the run-owned tools
  // selected by its role routing (#75).
  readonly agentImages: AgentImages;
  readonly worktreePath: string;
  // Absent when the run has no per-branch resolver at all (tests, a host that
  // declares no `rebuildOn`) — the declared tag is then the only answer.
  readonly branchImages?: BranchImages | undefined;
  // Does any `gateStack` container run `declaredTag`? It decides what the
  // fallback report can honestly promise, and is required for exactly that
  // reason — see above.
  readonly gateRunsSameImage: boolean;
  readonly onFallback?: (line: string) => void | Promise<void>;
}): Promise<string> {
  const { branchImages, declaredTag, worktreePath } = opts;
  if (!branchImages) return opts.agentImages.declaredTag;
  let base: string;
  try {
    const map = await branchImages.resolve(
      worktreePath,
      new Set([declaredTag]),
    );
    base = map.get(declaredTag) ?? declaredTag;
  } catch (err) {
    await opts.onFallback?.(
      `could not build a per-branch agent sandbox image from '${declaredTag}' ` +
        `for ${worktreePath}; starting the sandbox on '${opts.agentImages.declaredTag}' as ` +
        "the augmented declared image, which carries the source branch's version of its declared " +
        "inputs. " +
        (opts.gateRunsSameImage
          ? "A gate container runs this same image, so the gate resolves the " +
            "entry itself and will red with this build's output, against the " +
            "branch."
          : "No `gateStack` container runs this image, so nothing else ever " +
            "resolves it: the gate's verdict is computed from images that " +
            "built, and this line is the only report this failure gets.") +
        " The agent's environment is a commit behind its own branch until it " +
        `installs for itself: ${err instanceof Error ? err.message : String(err)}`,
    );
    return opts.agentImages.declaredTag;
  }
  try {
    return await opts.agentImages.augment(base);
  } catch (err) {
    await opts.onFallback?.(
      `resolved the per-branch agent sandbox image '${base}' for ` +
        `${worktreePath}, but could not append the run-owned agent tools; ` +
        `starting the sandbox on '${opts.agentImages.declaredTag}', whose ` +
        "environment is a commit behind its own branch. " +
        (opts.gateRunsSameImage
          ? "The gate runs the successfully resolved branch image, so it " +
            "cannot report this tool-layer failure; this line is the only " +
            "report it gets: "
          : "No `gateStack` container runs the sandbox image, and nothing " +
            "else resolves its tool layer; this line is the only report it " +
            "gets: ") +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return opts.agentImages.declaredTag;
  }
}
