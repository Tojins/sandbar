// Reflect's adapter (#182, #208): one window's run records to the proposals
// report. `reflect-cli.ts` parses argv and calls `reflect`; the decisions are
// pure in `reflect-mine.ts` and `reflect-report.ts`, and this module holds the
// I/O between them.
//
// The sequence: read the window through #194, `mine` it, build the
// workspace, tag each bucket chunk (`prompts/reflect-tagger.md`, the bucket's
// vocabulary and findings inline and nothing else), synthesize once
// (`prompts/reflect-synthesizer.md`, which only points at files), render, and
// write the report under `<stateDir>/reflect/` (tmp + rename). An empty bucket
// is tagged with no call, since its rules are still the universe deletion
// candidates draw from; with no cluster and no candidate the synthesizer is
// not called either, so a window where nothing recurs costs no tokens.
//
// The workspace (#182 Decision 8) is `<stateDir>/reflect/ws-<pid>/`, a fresh
// `git init` on one branch: `sandbar/prompts/*.md` from the running build and
// `consumer/<path>` for each anchor doc and prompt extension present at
// `origin/<sourceBranch>` in the bare cache, read with `--git-dir` and never
// fetched or locked, so the report prints the tip it read. The evidence files
// depend on the tags, so they are a second driver commit, written after
// tagging. The agents run in one sandbox in `reflectScope`, which no daemon
// sweep computes, on the daemon's own agent image: reflect never builds one,
// so a role routed to a CLI no daemon role runs, or an image the daemon has
// not built, stops it. The sandbox opens on the first cache miss, so a re-run
// needs no podman. One agent runs at a time, because each call is bracketed by
// its own read-only check: a call that moved HEAD or changed the status fails
// with `wrote`, and the workspace is put back for the next one.
//
// The cache (#182 Decision 7) is `<stateDir>/reflect/cache/<sha256>.json`,
// keyed on `REFLECT_CONTRACT_VERSION`, the step, its routing, the template
// and the full input: the prompt, and for the synthesizer every workspace
// file it may open. It keeps an answer that parsed, with the usage it cost,
// so the report is the same bytes whether an answer was cached or not: each
// step shows its key and what its answer cost when it was produced, and only
// the progress lines say which steps hit.
//
// A tagger failure (`wrote`, a parse error, a run that ended without an
// answer) loses that bucket's tag clusters; a synthesizer failure loses the
// proposals. Both are listed in the report. A quota, a credential, a missing
// runtime or an unbuilt image stops the command before any report is written.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  AgentError,
  AgentIdleTimeoutError,
  AgentInputTooLargeError,
  createSandbox,
  podman,
  type Sandbox,
} from "./agent-sandbox.js";
import { buildAgentProvider, requiredAgentProviders } from "./agent-providers.js";
import { createAgentImages } from "./agent-tools.js";
import type { AgentUsage } from "./agent-usage.js";
import { prepareCodexAuth } from "./codex-auth.js";
import type { ResolvedConfig } from "./config.js";
import { makeEnvReader } from "./env.js";
import { SandbarError, isErrno } from "./errors.js";
import { LOG_READ_TIMEOUT_MS, boundedOk, boundedPodman } from "./gate-stack.js";
import { readOnlyAgentSnapshotChanged, snapshotReadOnlyAgent } from "./inner-loop.js";
import { reflectScope, runScope, scopedResourcePrefix } from "./naming.js";
import { loadTemplate, readPromptFiles, render } from "./prompts.js";
import {
  chunkBucket,
  deletionCandidates,
  mine,
  outlierKey,
  parseTags,
  tagClusters,
  tagKey,
  type Bucket,
  type Cluster,
  type DeletionCandidate,
  type Member,
  type Mining,
  type Outlier,
  type Tag,
  type TaggedBucket,
} from "./reflect-mine.js";
import {
  parseSynthesis,
  renderReport,
  reportFileName,
  type AgentsRun,
  type StepFailure,
  type StepRecord,
  type Synthesis,
} from "./reflect-report.js";
import { repoLayout, type RepoLayout } from "./repo-cache.js";
import { repoSlug } from "./repo-ref.js";
import { RUNTIME } from "./runtime.js";
import { computeStats, type StatsReport } from "./stats.js";
import { readStatsInput, type StatsWindow } from "./stats-record.js";

const exec = promisify(execFile);

// Moves whenever a prompt's grammar or a parser does, so no cached answer
// outlives the contract it was parsed under.
export const REFLECT_CONTRACT_VERSION = 1;
export const EVIDENCE_MAX_CHARS = 20_000;
const MAX_GISTS = 5;
const WORKSPACE_BRANCH = "reflect";
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const TAGGER = loadTemplate("reflect-tagger");
const SYNTHESIZER = loadTemplate("reflect-synthesizer");

export type ReflectStep = "tagger" | "synthesizer";

// One call's answer, or why it gave none.
export type InvokeResult =
  | { readonly answer: string; readonly usage?: AgentUsage }
  | { readonly failure: string };

// The agents, in the workspace. `invoke` rejects only on what stops the whole
// command; `close` releases whatever the calls opened.
export type Invoker = {
  readonly invoke: (step: ReflectStep, prompt: string, name: string) => Promise<InvokeResult>;
  readonly close: () => Promise<void>;
};

export type ReflectOptions = {
  readonly logsDir: string;
  readonly window: StatsWindow;
  // False under `--no-agents`: the tables alone, with no workspace.
  readonly agents: boolean;
  // The sandboxed agents unless a test stubs them.
  readonly openInvoker?: (workspace: string) => Invoker;
  // Progress, one line per step; never part of the report.
  readonly log?: (line: string) => void;
};

const routing = (config: ResolvedConfig, step: ReflectStep) => step === "tagger"
  ? { agent: config.reflectTaggerAgent, model: config.reflectTaggerModelId, effort: config.reflectTaggerEffort }
  : {
      agent: config.reflectSynthesizerAgent,
      model: config.reflectSynthesizerModelId,
      effort: config.reflectSynthesizerEffort,
    };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const incoming = `${path}.tmp-${process.pid}`;
  await writeFile(incoming, content);
  await rename(incoming, path);
}

const git = async (args: readonly string[]): Promise<string> =>
  (await exec("git", [...args], { maxBuffer: GIT_MAX_BUFFER })).stdout;

// --- the workspace ---------------------------------------------------------

async function sourceTip(repoDir: string, sourceBranch: string): Promise<string> {
  return (await git([
    `--git-dir=${repoDir}`, "rev-parse", "--verify", `refs/remotes/origin/${sourceBranch}^{commit}`,
  ])).trim();
}

const sandbarFiles = (): Map<string, string> =>
  new Map([...readPromptFiles()].map(([name, text]) => [`sandbar/prompts/${name}`, text]));

// The anchor docs, the ADRs and every `{ path }` prompt extension that exist
// at the tip.
export async function consumerFiles(
  config: Pick<ResolvedConfig, "claudeMdPath" | "contextMdPath" | "adrDir" | "promptExtensions">,
  repoDir: string,
  tip: string,
): Promise<Map<string, string>> {
  const paths = [
    config.claudeMdPath, config.contextMdPath, config.adrDir,
    ...Object.values(config.promptExtensions).flatMap((extension) =>
      extension !== undefined && "path" in extension ? [extension.path] : []),
  ];
  const names = (await git([`--git-dir=${repoDir}`, "ls-tree", "-r", "-z", "--name-only", tip, "--", ...paths]))
    .split("\0").filter(Boolean);
  return new Map(await Promise.all(names.map(async (name) => [
    `consumer/${name}`,
    await git([`--git-dir=${repoDir}`, "cat-file", "blob", `${tip}:${name}`]),
  ] as const)));
}

const IDENTITY = [
  "-c", "user.name=sandbar reflect", "-c", "user.email=reflect@sandbar.invalid",
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
];

async function commitFiles(workspace: string, files: ReadonlyMap<string, string>, message: string): Promise<void> {
  await Promise.all([...files].map(async ([path, text]) => {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), text);
  }));
  await git(["-C", workspace, "add", "-A"]);
  await git(["-C", workspace, ...IDENTITY, "commit", "-q", "--allow-empty", "-m", message]);
}

export async function buildWorkspace(workspace: string, files: ReadonlyMap<string, string>): Promise<void> {
  // A crashed run under a recycled pid is the only thing that can be here.
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await git(["init", "-q", "-b", WORKSPACE_BRANCH, workspace]);
  await commitFiles(workspace, files, "reflect workspace");
}

// Runs one read-only call: one that moved HEAD or changed the status failed
// with `wrote`, and the workspace goes back to the commit it was at.
export async function guardReadOnly(
  workspace: string,
  call: () => Promise<InvokeResult>,
): Promise<InvokeResult> {
  const before = await snapshotReadOnlyAgent(workspace, WORKSPACE_BRANCH);
  const head = before.tip;
  if (head === null) throw new Error(`${workspace} has no ${WORKSPACE_BRANCH} branch before a call`);
  const [settled] = await Promise.allSettled([call()]);
  const after = await snapshotReadOnlyAgent(workspace, WORKSPACE_BRANCH);
  if (readOnlyAgentSnapshotChanged(before, after)) {
    await git(["-C", workspace, "checkout", "-q", "-f", "-B", WORKSPACE_BRANCH, head]);
    await git(["-C", workspace, "clean", "-q", "-f", "-d", "-x"]);
    return {
      failure: `wrote: HEAD ${after.headRef ?? "detached"} at ${after.tip}, ` +
        `status ${after.dirtyPaths.length === 0 ? "clean" : after.dirtyPaths.join(", ")}`,
    };
  }
  if (settled.status === "rejected") throw settled.reason;
  return settled.value;
}

// --- the sandboxed agents ----------------------------------------------------

async function openSandbox(config: ResolvedConfig, layout: RepoLayout, workspace: string): Promise<Sandbox> {
  const providers = requiredAgentProviders(config);
  for (const step of ["tagger", "synthesizer"] as const) {
    const { agent } = routing(config, step);
    if (!providers.includes(agent)) {
      throw new SandbarError(
        `reflect's ${step} is routed to ${agent}, which no daemon role runs, so the daemon's agent ` +
          `image has no ${agent} CLI. Reflect never builds images: route it to ${providers.join(" or ")}.`,
      );
    }
  }
  const probe = await boundedPodman(["--version"], LOG_READ_TIMEOUT_MS);
  if (!boundedOk(probe)) {
    throw new SandbarError(`\`${RUNTIME}\` is not usable, and reflect runs its agents in it.`);
  }
  // As run.ts does: the mount and the image's CODEX_HOME agree with the
  // daemon's, or the image's fingerprint would name one it never built.
  const env = makeEnvReader(config.env);
  const codexAuth = env("CODEX_AUTH_JSON");
  const codexHome = env("CODEX_HOME");
  const codexAuthMount = providers.includes("codex") && codexAuth !== undefined
    ? await prepareCodexAuth({
        stateDir: layout.stateDir,
        configuredJson: codexAuth,
        ...(codexHome === undefined ? {} : { codexHome }),
      })
    : undefined;
  const images = await createAgentImages({
    declaredBaseTag: config.sandboxImage,
    providers,
    ...(codexAuthMount === undefined ? {} : { codexHome: dirname(codexAuthMount.sandboxPath) }),
    scope: runScope(realpathSync(layout.stateDir)),
    build: (image) => Promise.reject(new SandbarError(
      `reflect never builds images, and '${image.tag}' is not built: a daemon run builds it.`,
    )),
    log: () => undefined,
  });
  const sandbox = await createSandbox({
    branch: WORKSPACE_BRANCH,
    sandbox: podman({
      imageName: images.declaredTag,
      namePrefix: scopedResourcePrefix(reflectScope(realpathSync(workspace))),
    }),
    layout: { ...layout, repoDir: workspace },
    env: config.env,
    preparedWorktreePath: workspace,
    ...(codexAuthMount === undefined ? {} : { extraMounts: [codexAuthMount] }),
  });
  // The workspace is reflect's own, not an issue clone: nothing to publish.
  sandbox.deferWorktreeReclaim();
  return sandbox;
}

function sandboxInvoker(config: ResolvedConfig, layout: RepoLayout, workspace: string): Invoker {
  let opening: Promise<Sandbox> | undefined;
  let sandbox: Sandbox | undefined;
  return {
    invoke: async (step, prompt, name) => {
      sandbox ??= await (opening ??= openSandbox(config, layout, workspace));
      const open = sandbox;
      const { agent, model, effort } = routing(config, step);
      return guardReadOnly(workspace, async () => {
        try {
          const result = await open.run({
            name: `reflect-${name.replace(/[^\w.-]+/g, "-")}`,
            model,
            agent: buildAgentProvider(agent, model, { effort }),
            prompt,
            completionSignal: [],
          });
          return { answer: result.stdout, ...(result.usage === undefined ? {} : { usage: result.usage }) };
        } catch (err) {
          // A run that ended without an answer; anything else is the host's.
          if (err instanceof AgentError || err instanceof AgentIdleTimeoutError ||
            err instanceof AgentInputTooLargeError) {
            return { failure: err.message };
          }
          throw err;
        }
      });
    },
    close: async () => {
      await sandbox?.close();
    },
  };
}

// --- the steps ---------------------------------------------------------------

type StepContext = {
  readonly config: ResolvedConfig;
  readonly invoker: Invoker;
  readonly cacheDir: string;
  readonly log: (line: string) => void;
};

type CacheEntry = { readonly answer: string; readonly usage?: AgentUsage };

type Parsed<T> = { readonly value: T } | { readonly error: string };

async function readCache(path: string): Promise<CacheEntry | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return null;
  }
  return JSON.parse(text) as CacheEntry;
}

// One step's answer, from the cache or from a call. Only an answer that
// parses is kept, so a failure is retried on the next run.
async function answerStep<T>(
  ctx: StepContext,
  step: ReflectStep,
  name: string,
  prompt: string,
  input: string,
  parse: (answer: string) => Parsed<T>,
): Promise<{ readonly value: T; readonly record: StepRecord } | { readonly failure: StepFailure }> {
  const { agent, model, effort } = routing(ctx.config, step);
  const key = sha256(JSON.stringify([
    REFLECT_CONTRACT_VERSION, step, agent, model, effort ?? null, step === "tagger" ? TAGGER : SYNTHESIZER, input,
  ]));
  const path = join(ctx.cacheDir, `${key}.json`);
  const cached = await readCache(path);
  const entry = cached ?? await ctx.invoker.invoke(step, prompt, name);
  if ("failure" in entry) return { failure: { step: name, reason: entry.failure } };
  const parsed = parse(entry.answer);
  if ("error" in parsed) return { failure: { step: name, reason: `parse: ${parsed.error}` } };
  if (cached === null) await writeAtomic(path, JSON.stringify(entry));
  ctx.log(`${name}: ${cached === null ? "answered" : "cached"}`);
  return {
    value: parsed.value,
    record: { step: name, key, ...(entry.usage === undefined ? {} : { usage: entry.usage }) },
  };
}

export function taggerPrompt(chunk: Bucket, minted: readonly string[]): string {
  const { vocabulary } = chunk;
  const labels = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");
  return render(TAGGER, {
    source: chunk.source,
    vocabulary: vocabulary.kind === "rules"
      ? labels(vocabulary.rules.map((rule) => `\`${rule.label}\`: ${rule.title}`))
      : minted.length === 0
        ? "No rule list, and no slug minted yet."
        : `No rule list. The slugs minted so far:\n\n${labels(minted.map((label) => `\`${label}\``))}`,
    findings: chunk.findings
      .map((finding) => `### ${finding.id} (issue #${finding.issue})\n\n${finding.prose.trim()}`)
      .join("\n\n"),
  });
}

type Tagging = {
  readonly tagged: readonly TaggedBucket[];
  readonly steps: readonly StepRecord[];
  readonly failures: readonly StepFailure[];
};

// Chunk by chunk, each told the `new:` slugs the earlier ones minted, so a
// slug can recur across calls (#182 Decision 4).
async function tagBuckets(ctx: StepContext, buckets: readonly Bucket[]): Promise<Tagging> {
  const tagged: TaggedBucket[] = [];
  const steps: StepRecord[] = [];
  const failures: StepFailure[] = [];
  for (const bucket of buckets) {
    const chunks = chunkBucket(bucket);
    const tags: Tag[] = [];
    let failure: StepFailure | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const minted = [...new Set(tags.map((tag) => tag.label).filter((label) => label.startsWith("new:")))];
      const prompt = taggerPrompt(chunk, minted);
      const answered = await answerStep(ctx, "tagger", `tagger ${bucket.source} ${index + 1}/${chunks.length}`,
        prompt, prompt, (answer) => {
          const parsed = parseTags(answer, chunk);
          return "error" in parsed ? parsed : { value: parsed.tags };
        });
      if ("failure" in answered) {
        failure = answered.failure;
        break;
      }
      steps.push(answered.record);
      tags.push(...answered.value);
    }
    if (failure === null) tagged.push({ bucket, tags });
    else failures.push(failure);
  }
  return { tagged, steps, failures };
}

export type Evidence = {
  readonly clusters: readonly Cluster[];
  readonly candidates: readonly DeletionCandidate[];
  readonly outliers: readonly Outlier[];
  // Each tag cluster's gists, in finding order.
  readonly gists: ReadonlyMap<string, readonly string[]>;
  // Each invocation's speech, by `memberProseKey`.
  readonly prose: ReadonlyMap<string, string>;
};

export const memberProseKey = (member: Pick<Member, "run" | "issue" | "transcript">): string =>
  `${member.run}/${member.issue}/${member.transcript ?? ""}`;

// Injective, and a plain file name for any key.
export const evidencePath = (key: string): string =>
  `evidence/${key.replace(/[^\w.:-]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}.md`;

// `evidence/clusters.md`, and the capped raw prose of each cluster with any.
export function evidenceFiles(evidence: Evidence): Map<string, string> {
  const raw = new Map<string, string>();
  for (const cluster of evidence.clusters) {
    const sections = cluster.members.flatMap((member) => {
      const prose = evidence.prose.get(memberProseKey(member));
      return prose === undefined ? [] : [`## #${member.issue} \`${member.transcript}\`\n\n${prose.trim()}\n`];
    });
    if (sections.length === 0) continue;
    const text = [`# \`${cluster.key}\``, "", ...sections].join("\n");
    raw.set(cluster.key, text.length <= EVIDENCE_MAX_CHARS
      ? text
      : `${text.slice(0, EVIDENCE_MAX_CHARS)}\n\n[capped at ${EVIDENCE_MAX_CHARS} chars]\n`);
  }
  const list = (items: readonly string[]): string => items.length === 0 ? "None.\n" : `${items.join("\n")}\n`;
  const clusters = evidence.clusters.map((cluster) => [
    `### \`${cluster.key}\``,
    "",
    `Issues ${cluster.issues.map((issue) => `#${issue}`).join(", ")}; ${cluster.count} members.` +
      (raw.has(cluster.key) ? ` Raw prose: \`${evidencePath(cluster.key)}\`.` : ""),
    ...(evidence.gists.get(cluster.key) ?? []).slice(0, MAX_GISTS).map((gist) => `- ${gist}`),
    "",
  ].join("\n"));
  return new Map([
    ["evidence/clusters.md", [
      "# Evidence",
      "",
      "Every key below may be cited.",
      "",
      "## Clusters",
      "",
      list(clusters),
      "## Deletion candidates",
      "",
      list(evidence.candidates.map((candidate) =>
        `- \`${candidate.key}\`: ${candidate.title} No tag hit over ${candidate.listerIssues} lister issues.`)),
      "## Outliers",
      "",
      list(evidence.outliers.map((outlier) =>
        `- \`${outlierKey(outlier)}\`: #${outlier.issue} ${outlier.outcome} after ${outlier.rounds} rounds, ` +
          `${outlier.attempts} attempts, ${outlier.specGaps ?? 0} spec gaps` +
          (outlier.reason === null ? "." : `; ${outlier.reason.replace(/\s+/g, " ")}`))),
    ].join("\n")],
    ...[...raw].map(([key, text]) => [evidencePath(key), text] as const),
  ]);
}

async function synthesize(
  ctx: StepContext,
  workspace: string,
  files: ReadonlyMap<string, string>,
  evidence: Evidence,
): Promise<{ readonly synthesis: Synthesis | null; readonly steps: readonly StepRecord[];
  readonly failures: readonly StepFailure[] }> {
  const written = evidenceFiles(evidence);
  await commitFiles(workspace, written, "reflect evidence");
  const prompt = render(SYNTHESIZER, { sourceBranch: ctx.config.sourceBranch });
  const context = {
    keys: new Set([
      ...evidence.clusters.map((cluster) => cluster.key),
      ...evidence.candidates.map((candidate) => candidate.key),
      ...evidence.outliers.map(outlierKey),
    ]),
    targets: new Set(files.keys()),
  };
  const input = JSON.stringify([prompt, ...[...files, ...written].sort(([a], [b]) => (a < b ? -1 : 1))]);
  const answered = await answerStep(ctx, "synthesizer", "synthesizer", prompt, input, (answer) => {
    const parsed = parseSynthesis(answer, context);
    return "error" in parsed ? parsed : { value: parsed };
  });
  return "failure" in answered
    ? { synthesis: null, steps: [], failures: [answered.failure] }
    : { synthesis: answered.value, steps: [answered.record], failures: [] };
}

type AgentsPart = {
  readonly clusters: readonly Cluster[];
  readonly candidates: readonly DeletionCandidate[];
  readonly agents: AgentsRun;
};

async function runAgents(
  config: ResolvedConfig,
  layout: RepoLayout,
  stats: StatsReport,
  mining: Mining,
  opts: ReflectOptions,
): Promise<AgentsPart> {
  const reflectDir = join(layout.stateDir, "reflect");
  const tip = await sourceTip(layout.repoDir, config.sourceBranch);
  const workspace = join(reflectDir, `ws-${process.pid}`);
  const files = new Map([...sandbarFiles(), ...await consumerFiles(config, layout.repoDir, tip)]);
  await buildWorkspace(workspace, files);
  const invoker = (opts.openInvoker ?? ((path: string) => sandboxInvoker(config, layout, path)))(workspace);
  const cleanup = async (): Promise<void> => {
    await invoker.close();
    await rm(workspace, { recursive: true, force: true });
  };
  const ctx: StepContext = { config, invoker, cacheDir: join(reflectDir, "cache"), log: opts.log ?? (() => undefined) };
  let part: AgentsPart;
  try {
    const tagging = await tagBuckets(ctx, mining.buckets);
    const clusters = [...mining.structured, ...tagClusters(tagging.tagged)];
    const candidates = deletionCandidates(tagging.tagged);
    const synthesis = clusters.length + candidates.length === 0
      ? { synthesis: null, steps: [], failures: [] }
      : await synthesize(ctx, workspace, files, {
          clusters,
          candidates,
          outliers: mining.outliers,
          gists: gistsOf(tagging.tagged),
          prose: new Map(stats.invocations.flatMap((row) =>
            row.transcript === null || typeof row.prose !== "string"
              ? []
              : [[memberProseKey({ run: row.run, issue: row.issue, transcript: row.transcript }), row.prose]])),
        });
    part = {
      clusters,
      candidates,
      agents: {
        sourceBranch: config.sourceBranch,
        tip,
        steps: [...tagging.steps, ...synthesis.steps],
        failures: [...tagging.failures, ...synthesis.failures],
        synthesis: synthesis.synthesis,
      },
    };
  } catch (err) {
    await cleanup().catch((cleanupError: unknown) => {
      console.error(`reflect: could not remove ${workspace} after a failure: ${String(cleanupError)}`);
    });
    throw err;
  }
  await cleanup();
  return part;
}

const gistsOf = (tagged: readonly TaggedBucket[]): Map<string, string[]> => {
  const gists = new Map<string, string[]>();
  for (const { bucket, tags } of tagged) {
    for (const tag of tags) {
      const key = tagKey(bucket.source, tag.label);
      gists.set(key, [...(gists.get(key) ?? []), tag.gist]);
    }
  }
  return gists;
};

export async function reflect(
  config: ResolvedConfig,
  opts: ReflectOptions,
): Promise<{ readonly reportPath: string; readonly report: string }> {
  const layout = repoLayout(config.cwd, config.workDir);
  const stats = computeStats(await readStatsInput(opts.logsDir, opts.window, { withProse: true }));
  const mining = mine(stats, { quality: loadTemplate("coding-standards") });
  const base = {
    stats,
    outliers: mining.outliers,
    logsDir: opts.logsDir,
    repo: repoSlug({ owner: config.ghOwner, name: config.ghRepo }),
  };
  const report = renderReport(opts.agents
    ? { ...base, ...await runAgents(config, layout, stats, mining, opts) }
    // Only a tagged bucket can show a rule unused, and no agent ran.
    : { ...base, clusters: mining.structured, candidates: [], agents: null });
  const reportPath = join(layout.stateDir, "reflect", reportFileName(stats, report));
  await writeAtomic(reportPath, report);
  return { reportPath, report };
}
