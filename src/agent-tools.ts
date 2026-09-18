// Driver-owned agent tool images and sandbox image resolution (#46, #75, #76,
// #162).
//
// The branch owns the environment; the run owns the tools. Provider pins live
// in agent-providers.ts and are content addresses: Buildah verifies every
// remote ADD against that digest, and codex's pin moves with its JSONL parser.
// A provider may install sibling binaries such as codex-code-mode-host from
// that same pin (#120).
//
// There is no host artifact store. One persistent tools image per workdir
// scope, pin fingerprint and libc holds the release binaries in podman's own
// storage. Its generated recipe downloads with `ADD --checksum`; augmentation
// copies the selected binaries from that local image. The tools tag survives a
// clean run so a daemon restart does not re-download hundreds of MiB. Startup
// removes this scope's tags for pins the running driver no longer names.
//
// Dynamic releases require a libc choice, so augmentation probes the resolved
// base with an entrypoint-neutral podman run. Only an explicit, unsignalled
// exit 0 is an answer (#119): podman can trap a timeout signal and itself exit
// cleanly even when no container started. Bases need only /bin/sh, CA roots,
// and git or apt/apk/dnf; the generated layer supplies git, uid 1000, and each
// standalone CLI, then probes every installed binary. When Codex's shared auth
// file will be mounted, the layer also creates its configured CODEX_HOME as the
// agent user: a file bind whose missing parent is created by the runtime would
// otherwise leave Codex unable to write sibling session state (#134). Bare CLI
// probes cannot prove their embedded trust stores, so CA roots remain a base
// requirement.
//
// Sandbox resolution is deliberately softer than gate image resolution only
// for the branch-authored recipe (#46): that failure falls back to the
// augmented declared image so the agent that must repair it can still start.
// A failure while building or copying the driver-owned tools is infrastructure
// and propagates to HARD-ERROR; an agent cannot repair it from a stale sandbox.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  AGENT_PROVIDER_PACKAGES,
  type AgentArtifact,
  type AgentProviderName,
  type AgentProviderPackage,
} from "./agent-providers.js";
import { registerDisposable } from "./cleanup.js";
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
import {
  type RunScope,
  toolsImageTag,
  variantImageTag,
} from "./naming.js";
import { RUNTIME } from "./runtime.js";
import { startTimer } from "./timing.js";

const exec = promisify(execFile);

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

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
  toolsImageTag: string,
  providers: readonly AgentProviderName[],
  options: {
    readonly arch?: "x64" | "arm64";
    readonly packages?: typeof AGENT_PROVIDER_PACKAGES;
    readonly libc: "glibc" | "musl";
    readonly codexHome?: string;
  },
): string {
  const arch = options.arch ?? hostAgentArchitecture();
  const packages = options.packages ?? AGENT_PROVIDER_PACKAGES;
  const libc = options.libc;
  const installed = providers.flatMap((provider) =>
    selectedAgentArtifacts(packages[provider], arch, libc, provider)
      .map((artifact) => ({
        provider,
        binary: agentArtifactBinary(provider, artifact),
      })),
  );
  const copies = installed.map(({ binary }) =>
    `COPY --from=${toolsImageTag} /usr/local/bin/${binary} /usr/local/bin/${binary}`,
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
  const codexHome = providers.includes("codex")
    ? options.codexHome ?? "/home/agent/.codex"
    : undefined;
  const codexHomeClause = codexHome === undefined
    ? ""
    : `; if [ ! -e ${shellQuote(codexHome)} ]; then ` +
      `mkdir -p ${shellQuote(codexHome)} && ` +
      `chown 1000:$(id -g agent) ${shellQuote(codexHome)}; fi`;
  const agentUserClause = [
    "uid_user=$(awk -F: '$3 == 1000 { print $1; exit }' /etc/passwd);",
    'if [ -n "$uid_user" ] && [ "$uid_user" != agent ]; then',
    'sed -i "s/^$uid_user:/agent:/" /etc/passwd; fi;',
    "if ! id agent >/dev/null 2>&1; then",
    "if command -v useradd >/dev/null; then",
    "useradd -u 1000 -m -d /home/agent agent;",
    "else adduser -D -u 1000 -h /home/agent agent; fi; fi;",
    "mkdir -p /home/agent && chown -R 1000:$(id -g agent) /home/agent" +
      codexHomeClause,
  ].join(" ");
  const probeClause = [
    probes,
    "git --version",
    'test "$(id -u agent)" = 1000',
    'test "$(stat -c %u /home/agent)" = 1000',
    ...(codexHome === undefined
      ? []
      : [
          `test -d ${shellQuote(codexHome)}`,
          `test "$(stat -c %u ${shellQuote(codexHome)})" = 1000`,
        ]),
  ].join(" && ");
  return [
    `FROM ${baseTag}`,
    "USER 0",
    `RUN ${gitClause}`,
    `RUN ${agentUserClause}`,
    copies,
    `RUN ${probeClause}`,
    "",
  ].join("\n");
}

export function agentToolsImageContainerfile(
  builderBaseTag: string,
  providers: readonly AgentProviderName[],
  options: {
    readonly arch?: "x64" | "arm64";
    readonly packages?: typeof AGENT_PROVIDER_PACKAGES;
    readonly libc: "glibc" | "musl";
  },
): string {
  const arch = options.arch ?? hostAgentArchitecture();
  const packages = options.packages ?? AGENT_PROVIDER_PACKAGES;
  const installed = providers.flatMap((provider) =>
    selectedAgentArtifacts(packages[provider], arch, options.libc, provider)
      .map((artifact) => ({
        artifact,
        binary: agentArtifactBinary(provider, artifact),
        name: agentArtifactName(provider, artifact),
      })),
  );
  const needsTar = installed.some(({ artifact }) => artifact.archive === true);
  const tarClause = [
    "command -v tar >/dev/null ||",
    "if command -v apt-get >/dev/null; then",
    "apt-get update && apt-get install -y --no-install-recommends tar &&",
    "rm -rf /var/lib/apt/lists/*;",
    "elif command -v apk >/dev/null; then apk add --no-cache tar;",
    "elif command -v dnf >/dev/null; then dnf install -y tar && dnf clean all;",
    "else echo 'tar is missing and no supported package manager (apt-get, apk, dnf) is available' >&2; exit 1; fi",
  ].join(" ");
  const additions = installed.flatMap(({ artifact, binary, name }) => {
    const downloaded = `/tmp/${name}.download`;
    const add = `ADD --checksum=sha256:${artifact.sha256} ${artifact.url} ${downloaded}`;
    if (!artifact.archive) {
      return [
        add,
        `RUN mkdir -p /usr/local/bin && mv ${downloaded} /usr/local/bin/${binary} && ` +
          `chmod 0755 /usr/local/bin/${binary}`,
      ];
    }
    const extracted = `/tmp/${name}.extracted`;
    return [
      add,
      `RUN set -eu; mkdir -p ${extracted} /usr/local/bin; ` +
        `tar -xzf ${downloaded} -C ${extracted}; ` +
        `if [ -f ${extracted}/${binary} ]; then member=${extracted}/${binary}; ` +
        `else set -- ${extracted}/${binary}-*; ` +
        `if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then ` +
        `echo 'archive contains no unique ${binary} binary' >&2; exit 1; fi; ` +
        `member="$1"; fi; mv "$member" /usr/local/bin/${binary}; ` +
        `chmod 0755 /usr/local/bin/${binary}; rm -rf ${downloaded} ${extracted}`,
    ];
  });
  return [
    `FROM ${builderBaseTag} AS downloads`,
    "USER 0",
    ...(needsTar ? [`RUN ${tarClause}`] : []),
    ...additions,
    "FROM scratch",
    "COPY --from=downloads /usr/local/bin/ /usr/local/bin/",
    "",
  ].join("\n");
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
  // that resolves to the SAME path in the tools image and augmentation — one
  // destination, last write wins, a silently wrong install. Data this module
  // owns, so a guard rather than a type, but the grouping argument above is
  // only true while it holds.
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

export function agentToolsFingerprint(
  providers: readonly AgentProviderName[],
  libc: "glibc" | "musl",
  options: {
    readonly arch?: "x64" | "arm64";
    readonly packages?: typeof AGENT_PROVIDER_PACKAGES;
  } = {},
): string {
  const arch = options.arch ?? hostAgentArchitecture();
  const packages = options.packages ?? AGENT_PROVIDER_PACKAGES;
  const pins = [...providers].sort().map((provider) => ({
    provider,
    version: packages[provider].version,
    artifacts: selectedAgentArtifacts(
      packages[provider], arch, libc, provider,
    ).map((artifact) => ({
      binary: agentArtifactBinary(provider, artifact),
      variant: artifact.variant,
      url: artifact.url,
      sha256: artifact.sha256,
      archive: artifact.archive === true,
    })),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ arch, libc, pins }))
    .digest("hex");
}

export function agentToolsImageTags(
  scope: RunScope,
  providers: readonly AgentProviderName[],
): readonly string[] {
  return (["glibc", "musl"] as const).map((libc) =>
    toolsImageTag(scope, libc, agentToolsFingerprint(providers, libc))
  );
}

export type AgentImages = {
  readonly declaredTag: string;
  readonly augment: (baseTag: string) => Promise<string>;
  readonly builtTags: () => readonly string[];
  readonly liveTags: () => readonly string[];
};

// Named so the inner loop can classify this driver/host failure as
// infrastructure even though it remains a SandbarError for concise startup
// reporting. A branch-authored ImageBuildError is deliberately not this type.
export class AgentToolsImageError extends SandbarError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentToolsImageError";
  }
}

export async function createAgentImages(opts: {
  readonly declaredBaseTag: string;
  readonly providers: readonly AgentProviderName[];
  readonly codexHome?: string;
  readonly scope: RunScope;
  readonly build?: (image: BuiltImage, opts: BuildOptions) => Promise<unknown>;
  readonly inputsLabel?: (tag: string) => Promise<string | null>;
  readonly log?: (line: string) => void;
  readonly onImage?: ImageRecorder;
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
  const toolsPending = new Map<"glibc" | "musl", Promise<string>>();
  const toolsUsed = new Set<string>();
  const order: string[] = [];

  const buildGenerated = async (
    tag: string,
    containerfile: string,
    fingerprint: string,
    identity: string,
  ): Promise<void> => {
    const contextRoot = await mkdtemp(join(tmpdir(), "sandbar-agent-context-"));
    const withdrawContextCleanup = registerDisposable(
      () => rm(contextRoot, { recursive: true, force: true }),
    );
    try {
      await writeFile(join(contextRoot, "Containerfile"), containerfile);
      await build(
        { tag, containerfile: identity },
        { scope: opts.scope, root: "", contextRoot, fingerprint, capture: true },
      );
    } finally {
      await rm(contextRoot, { recursive: true, force: true });
      withdrawContextCleanup();
    }
  };

  const toolsImage = (libc: "glibc" | "musl"): Promise<string> => {
    let promise = toolsPending.get(libc);
    if (promise === undefined) {
      promise = (async () => {
        const elapsed = startTimer();
        const fingerprint = agentToolsFingerprint(opts.providers, libc, { arch });
        const tag = toolsImageTag(opts.scope, libc, fingerprint);
        toolsUsed.add(tag);
        if ((await inputsLabel(tag)) !== fingerprint) {
          log(`Building persistent agent tools image '${tag}' for ${toolset}...`);
          await buildGenerated(
            tag,
            agentToolsImageContainerfile(
              opts.declaredBaseTag,
              opts.providers,
              { arch, libc },
            ),
            fingerprint,
            "<generated-agent-tools-download>",
          );
          await opts.onImage?.({
            tag,
            built: true,
            reason: "tools-stale",
            durationMs: elapsed(),
          });
        } else {
          await opts.onImage?.({
            tag,
            built: false,
            reason: "tools-current",
            durationMs: elapsed(),
          });
        }
        return tag;
      })().catch((err) => {
        toolsPending.delete(libc);
        throw err;
      });
      toolsPending.set(libc, promise);
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
        const toolsTag = await toolsImage(libc);
        const containerfile = agentToolsContainerfile(
          baseTag,
          toolsTag,
          opts.providers,
          {
            arch,
            libc,
            ...(opts.codexHome === undefined ? {} : { codexHome: opts.codexHome }),
          },
        );
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
          await buildGenerated(
            tag,
            containerfile,
            fingerprint,
            "<generated-agent-tools-augmentation>",
          );
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
        throw new AgentToolsImageError(
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
  return {
    declaredTag,
    augment,
    builtTags: () => [...order],
    liveTags: () => [...toolsUsed, ...order],
  };
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
// Appending run-owned tools is a different authority. Its recipe, downloads
// and storage are all host/driver concerns, not bytes the branch can repair.
// Such a failure propagates through sandbox bringup as HARD-ERROR instead of
// spending agent attempts in an environment one commit behind the branch.
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
  return opts.agentImages.augment(base);
}
