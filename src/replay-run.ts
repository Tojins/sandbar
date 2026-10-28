// `replay freeze` and `replay run` (#195): the adapter under `replay.ts`.
//
// HUMAN-ONLY. Nothing in the daemon, the CLI, any prompt or reflect reaches
// this module (replay-boundary.test.ts); AGENTS.md forbids agents to run it.
//
// LAYOUT. Everything lives in `<cwd>/<workDir>/replay/`, gitignored with the
// state directory: its own `run.lock` (never the daemon's lock, never the
// origin lease, so neither can deadlock the other), and a realpath that gives
// it its own `runScope`, so its containers and images are invisible to the
// daemon's sweeps and the daemon's to its. `repo.git` is the replay base
// cache, `ensureRepoCache`'s layout with its push url pointed at a path that
// does not exist. `sessions/<label>/` is one `run`: `replay.json` (the
// manifest), `logs/run-*` (one ordinary event record per repeat, which
// `npm run stats --logs <session>/logs` reads) and `cases/<issue>-r<k>/`.
//
// FREEZE reads: the base cache is fetched, the run records are scanned
// newest-first for each issue's last DONE and its `admitted`, and a seed or
// issue the admission did not record is reconstructed from the landing merge
// (`Merge sandbar/issue-<n>: …` on `origin/<source>`, whose merge base is the
// seed) and from today's issue, keeping the comments made by the cutoff — the
// admission's time, or with no record the earliest author date on the
// branch — and flagging a body edited after it. A case with no seed source
// fails the whole freeze; the file is written create-only.
//
// RUN drives `runInnerLoop` directly — no planner, merger, finalize or lease,
// which is where every origin and tracker write of `run()` lives — for every
// case × repeat, repeat-major, `--parallel` at a time.
//
// THE CAPABILITY BOUNDARY is not an audit of call sites. Before anything else,
// `guardReplayProcess` deletes the forge credentials from the process
// environment, points `GH_CONFIG_DIR` at an empty directory and puts a `gh` on
// PATH that refuses with exit 97; every sandbox's env has the same keys
// stripped. Every case gets its own bare cache, a hardlinked clone of the base
// cache holding exactly `refs/remotes/origin/<source>` at the seed, whose
// origin is itself, whose push url does not exist and which refuses every
// push into it. No repository replay creates has a remote that leaves the box,
// so a write site reached by any path fails loudly. `config.sandboxHooks` and
// `copyToWorktree` still run as configured: they are consumer code, and the
// host checkout stays read-only to them as in a run.
//
// IMAGES. Declared tags are host-global and the daemon's: replay builds none
// (`existingBaseFingerprints`), only scope-tagged tools images and per-branch
// variants, so a seed whose `rebuildOn` inputs differ gets its own variant.
// Codex roles mount the daemon's `codex-auth.json` (`existingCodexAuth`). Each
// case's gate stack is read from its own cache, so it is the seed's, and every
// distinct one passes the host checks before any token is spent.
//
// A QUOTA or CREDENTIAL terminal stops the session: the cases still running
// finish, every case not yet started is recorded `not-run` with that reason,
// and `runReplay` answers 3. Any rejection stops it too, after its REJECTED
// terminal is recorded, and propagates.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import { reclaimIssueClone } from "./agent-sandbox.js";
import { agentToolsImageTags, createAgentImages } from "./agent-tools.js";
import { requiredAgentProviders } from "./agent-providers.js";
import { installCleanupTraps, onCleanup, registerDisposable, runCleanup } from "./cleanup.js";
import { existingCodexAuth } from "./codex-auth.js";
import type { ResolvedConfig } from "./config.js";
import { cleanupOrphanContainers } from "./containers.js";
import { formatLowGraphRootSpace, graphRootSpace, graphRootSpaceIsLow, podmanGraphRoot } from "./disk-space.js";
import { formatDriverIdentity, readDriverIdentity } from "./driver-identity.js";
import {
  type BranchImages,
  createBranchImages,
  existingBaseFingerprints,
  worktreeMountingTagsOf,
} from "./ensure-images.js";
import { makeEnvReader } from "./env.js";
import { SandbarError, isErrno, isExitCode } from "./errors.js";
import {
  type EventInput,
  type EventRecord,
  EventRecordReadError,
  parseEventLines,
  startEventRecord,
} from "./events.js";
import { type GateSemaphore, createGateSemaphore } from "./gate-semaphore.js";
import { gitStdout } from "./git-ops.js";
import { reconcileImages } from "./image-lifecycle.js";
import {
  type InnerLoopConfig,
  type RunProviderState,
  type Terminal,
  createRunProviderState,
  runInnerLoop,
} from "./inner-loop.js";
import { type IssueJson, fetchIssueLastEditedAt, fetchIssueSnapshot, issueJsonErrors } from "./issue-anchor.js";
import { acquireLock, lockPathsFor } from "./lock.js";
import { issueBranchName, issueMergeSubject, parseIssueMergeSubject, runScope } from "./naming.js";
import { checkStackOnHost } from "./preflight.js";
import { type RepoLayout, ensureRepoCache, repoLayout, worktreePathFor } from "./repo-cache.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";
import {
  type CaseText,
  FORGE_CREDENTIAL_KEYS,
  type PlannedRun,
  type RecordedAdmission,
  type ReplayCase,
  type ReplayCases,
  type ReplayResult,
  type ReplaySession,
  type RoleRouting,
  type SeedFrom,
  caseCacheRefUpdates,
  commentsAtCutoff,
  lastDoneAdmission,
  parseNumstat,
  parseReplayCases,
  planReplay,
  renderReplayPlan,
  stripForgeCredentials,
} from "./replay.js";
import { innerLoopConfigOf, rejectedEnding, sandboxEnvOf, terminalEventOf, terminalReason } from "./run.js";
import { type StackSource, openStackSource, stackSpecToken } from "./stack-source.js";
import { startTimer } from "./timing.js";

export const GH_DISABLED_EXIT = 97;

export function replayLayout(config: Pick<ResolvedConfig, "cwd" | "workDir">): RepoLayout {
  return repoLayout(config.cwd, join(config.workDir, "replay"));
}

// The process guard (decision 2). After it, nothing this process or a child
// it spawns holds a forge credential, and `gh` on PATH refuses.
export async function guardReplayProcess(replayDir: string): Promise<void> {
  for (const key of FORGE_CREDENTIAL_KEYS) delete process.env[key];
  const ghConfigDir = join(replayDir, "gh-config");
  await rm(ghConfigDir, { recursive: true, force: true });
  await mkdir(ghConfigDir, { recursive: true });
  process.env.GH_CONFIG_DIR = ghConfigDir;
  const bin = join(replayDir, "bin");
  await mkdir(bin, { recursive: true });
  const shim = join(bin, "gh");
  await writeFile(shim, `#!/bin/sh\necho "sandbar replay: gh is disabled" >&2\nexit ${GH_DISABLED_EXIT}\n`);
  await chmod(shim, 0o755);
  process.env.PATH = [bin, process.env.PATH].filter((entry) => entry !== undefined && entry !== "").join(delimiter);
}

const REFUSE_PUSH_HOOK = "#!/bin/sh\necho \"sandbar replay: this cache accepts no push\" >&2\nexit 1\n";

// One case's cache (decision 3): a hardlinked clone of the base cache that
// holds exactly `origin/<sourceBranch>` at the seed, whose origin is itself,
// whose push url does not exist, and which refuses a push into it.
export async function prepareCaseCache(args: {
  readonly baseRepoDir: string;
  readonly caseDir: string;
  readonly hostCwd: string;
  readonly sourceBranch: string;
  readonly seedSha: string;
}): Promise<RepoLayout> {
  const layout = { ...repoLayout(args.caseDir, ""), hostCwd: args.hostCwd };
  const { repoDir } = layout;
  await mkdir(args.caseDir, { recursive: true });
  await gitStdout(args.caseDir, ["clone", "--bare", "--local", "--quiet", args.baseRepoDir, repoDir]);
  const refs = (await gitStdout(repoDir, ["for-each-ref", "--format=%(refname)"]))
    .split("\n").filter((ref) => ref !== "");
  await gitStdout(repoDir, ["update-ref", "--stdin"], `${caseCacheRefUpdates(refs, args.sourceBranch, args.seedSha).join("\n")}\n`);
  await gitStdout(repoDir, ["config", "remote.origin.url", repoDir]);
  await gitStdout(repoDir, ["config", "remote.origin.pushurl", join(args.caseDir, "push-forbidden")]);
  await gitStdout(repoDir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  const hook = join(repoDir, "hooks", "pre-receive");
  await mkdir(dirname(hook), { recursive: true });
  await writeFile(hook, REFUSE_PUSH_HOOK);
  await chmod(hook, 0o755);
  return layout;
}

// ---------------------------------------------------------------------------
// freeze
// ---------------------------------------------------------------------------

type LandingMerge = {
  readonly merge: string;
  readonly base: string;
  readonly tip: string;
  readonly title: string;
};

// The newest merge the merger made of the issue's branch into the source's
// history — a chunk member's too, which sits behind its chunk's merge.
async function landingMerge(repoDir: string, sourceBranch: string, issue: number): Promise<LandingMerge | null> {
  const log = await gitStdout(repoDir, [
    "log", "--merges", "--fixed-strings", `--grep=${issueMergeSubject(issue, "")}`,
    "--format=%H %P%x09%s", `refs/remotes/origin/${sourceBranch}`,
  ]);
  for (const line of log.split("\n")) {
    const [shas = "", subject = ""] = line.split("\t");
    const parsed = parseIssueMergeSubject(subject);
    const [merge, first, second] = shas.split(" ");
    if (parsed?.issue !== issue || merge === undefined || first === undefined || second === undefined) continue;
    const base = (await gitStdout(repoDir, ["merge-base", first, second])).trim();
    return { merge, base, tip: second, title: parsed.title };
  }
  return null;
}

// Each issue's last DONE admission, from the newest run that has one.
async function recordedAdmissions(
  logsDir: string,
  issues: readonly number[],
): Promise<ReadonlyMap<number, RecordedAdmission>> {
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    names = [];
  }
  const found = new Map<number, RecordedAdmission>();
  for (const run of names.filter((name) => name.startsWith("run-")).sort().reverse()) {
    if (found.size === issues.length) break;
    const path = join(logsDir, run, "events.jsonl");
    let events: Parameters<typeof lastDoneAdmission>[1];
    try {
      ({ events } = parseEventLines(await readFile(path, "utf8"), path));
    } catch (err) {
      if (!isErrno(err, "ENOENT") && !(err instanceof EventRecordReadError)) throw err;
      continue;
    }
    for (const issue of issues) {
      const admission = found.has(issue) ? null : lastDoneAdmission(run, events, issue);
      if (admission !== null) found.set(issue, admission);
    }
  }
  return found;
}

async function earliestAuthorDate(repoDir: string, seed: string, tip: string): Promise<string | null> {
  const dates = (await gitStdout(repoDir, ["log", "--format=%aI", `${seed}..${tip}`]))
    .split("\n").filter((date) => date !== "");
  return dates.reduce<string | null>(
    (earliest, date) => earliest === null || Date.parse(date) < Date.parse(earliest) ? date : earliest,
    null,
  );
}

type FrozenCase = { readonly case: ReplayCase } | { readonly failure: string };

async function freezeCase(args: {
  readonly issue: number;
  readonly admission: RecordedAdmission | null;
  readonly logsDir: string;
  readonly repoDir: string;
  readonly sourceBranch: string;
  readonly repo: RepoRef;
}): Promise<FrozenCase> {
  const { issue, admission, repoDir } = args;
  const merge = await landingMerge(repoDir, args.sourceBranch, issue);
  const seed: { readonly seedSha: string; readonly seedFrom: SeedFrom } | null =
    admission !== null && admission.seedSha !== null
      ? { seedSha: admission.seedSha, seedFrom: "recorded" }
      : merge !== null ? { seedSha: merge.base, seedFrom: "merge-base" } : null;
  // The title it was admitted under, else the one it landed under: its branch
  // name, and so every prompt, depend on it.
  const title = admission?.title ?? merge?.title;
  if (seed === null || title === undefined) {
    return {
      failure: `#${issue}: no recorded seed and no \`${issueMergeSubject(issue, "…")}\` merge on ` +
        `origin/${args.sourceBranch}; a case for it needs its seedSha written by hand (seedFrom: "manual")`,
    };
  }
  let text: CaseText & { readonly issueJson: IssueJson };
  if (admission !== null && admission.issueSnapshot !== null) {
    const path = join(args.logsDir, admission.run, `issue-${issue}`, admission.issueSnapshot);
    const snapshot: unknown = JSON.parse(await readFile(path, "utf8"));
    const errors = issueJsonErrors(snapshot);
    if (errors.length > 0) throw new SandbarError(`${path} is not an issue snapshot: ${errors.join("; ")}`);
    text = { issueFrom: "recorded", issueJson: snapshot as IssueJson };
  } else {
    const cutoff = admission?.ts ?? (merge === null ? null : await earliestAuthorDate(repoDir, seed.seedSha, merge.tip));
    if (cutoff === null) return { failure: `#${issue}: no admission time and no commit on its branch to date it by` };
    const [current, lastEditedAt] = await Promise.all([
      fetchIssueSnapshot(String(issue), args.repo),
      fetchIssueLastEditedAt(issue, args.repo),
    ]);
    text = {
      issueFrom: "reconstructed",
      editedAfterAdmission: lastEditedAt !== null && Date.parse(lastEditedAt) > Date.parse(cutoff),
      issueJson: commentsAtCutoff(current, cutoff),
    };
  }
  return {
    case: {
      issue,
      title,
      ...seed,
      ...text,
      original: admission === null ? null : { logsDir: args.logsDir, run: admission.run },
      landed: merge === null ? null : {
        merge: merge.merge,
        tip: merge.tip,
        diff: parseNumstat(await gitStdout(repoDir, ["diff", "--numstat", merge.base, merge.tip])),
      },
    },
  };
}

const short = (sha: string): string => sha.slice(0, 10);

function describeCase(c: ReplayCase): string {
  const text = c.issueFrom === "recorded"
    ? "recorded"
    : `reconstructed${c.editedAfterAdmission ? ", body edited after admission" : ""}`;
  return `#${c.issue} ${c.title}: seed ${short(c.seedSha)} (${c.seedFrom}), issue ${text}, ` +
    `original ${c.original?.run ?? "none"}, landed ${c.landed === null ? "none" : short(c.landed.merge)}`;
}

export async function freeze(args: {
  readonly config: Pick<ResolvedConfig, "cwd" | "workDir" | "ghOwner" | "ghRepo" | "sourceBranch">;
  readonly issues: readonly number[];
  readonly logsDir: string;
  readonly out: string;
  readonly log: (line: string) => void;
}): Promise<void> {
  const { config } = args;
  const layout = replayLayout(config);
  const release = await acquireLock(lockPathsFor(layout.stateDir));
  try {
    await ensureRepoCache(layout, args.log);
    await gitStdout(layout.repoDir, ["config", "remote.origin.pushurl", join(layout.stateDir, "push-forbidden")]);
    await gitStdout(layout.repoDir, ["fetch", "origin", "--prune", "--quiet"]);
    const repo = { owner: config.ghOwner, name: config.ghRepo };
    const admissions = await recordedAdmissions(args.logsDir, args.issues);
    const frozen = await Promise.all(args.issues.map((issue) => freezeCase({
      issue,
      admission: admissions.get(issue) ?? null,
      logsDir: args.logsDir,
      repoDir: layout.repoDir,
      sourceBranch: config.sourceBranch,
      repo,
    })));
    const failures = frozen.flatMap((f) => "failure" in f ? [f.failure] : []);
    if (failures.length > 0) {
      throw new SandbarError(`Nothing frozen; no seed source for:\n${failures.join("\n")}`);
    }
    const cases = frozen.flatMap((f) => "case" in f ? [f.case] : []);
    const file: ReplayCases = { replayCases: 1, repo: repoSlug(repo), sourceBranch: config.sourceBranch, cases };
    await writeFile(args.out, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
    for (const c of cases) args.log(describeCase(c));
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export function replayRouting(config: ResolvedConfig): Readonly<Record<string, RoleRouting>> {
  const role = (agent: string, model: string, effort: string | undefined): RoleRouting =>
    ({ agent, model, effort: effort ?? null });
  return {
    implementer: role(config.implementerAgent, config.implementerModelId, config.implementerEffort),
    uiCheck: role(config.uiCheckAgent, config.uiCheckModelId, config.uiCheckEffort),
    reviewer: role(config.reviewerAgent, config.reviewerModelId, config.reviewerEffort),
    reviewerQuality: role(config.reviewerQualityAgent, config.reviewerQualityModelId, config.reviewerQualityEffort),
    adjudicator: role(config.adjudicatorAgent, config.adjudicatorModelId, config.adjudicatorEffort),
  };
}

async function readCases(casesFile: string, config: ResolvedConfig): Promise<{
  readonly cases: ReplayCases;
  readonly sha256: string;
}> {
  const bytes = await readFile(casesFile);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new SandbarError(`${casesFile} is not JSON: ${err.message}`);
  }
  const parsed = parseReplayCases(json);
  if ("errors" in parsed) throw new SandbarError(`${casesFile}:\n${parsed.errors.join("\n")}`);
  const configured = repoSlug({ owner: config.ghOwner, name: config.ghRepo });
  if (parsed.cases.repo !== configured || parsed.cases.sourceBranch !== config.sourceBranch) {
    throw new SandbarError(
      `${casesFile} was frozen from ${parsed.cases.repo} ${parsed.cases.sourceBranch}, ` +
        `but the config names ${configured} ${config.sourceBranch}`,
    );
  }
  return { cases: parsed.cases, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function missingSeeds(baseRepoDir: string, cases: readonly ReplayCase[]): Promise<readonly string[]> {
  const present = await Promise.all(cases.map(async (c) => {
    try {
      await gitStdout(baseRepoDir, ["rev-parse", "--verify", "--quiet", `${c.seedSha}^{commit}`]);
      return true;
    } catch (err) {
      if (!isExitCode(err, 1)) throw err;
      return false;
    }
  }));
  return cases.filter((_, i) => !present[i]).map((c) => `#${c.issue} ${c.seedSha}`);
}

// The session manifest: `replay.json`, rewritten whole (tmp + rename) after
// every result. Pool workers share one, so the writes are chained inside it:
// callers never coordinate, and the file's results are in the order of the
// `append` calls.
export interface SessionManifest {
  // Rewrites the file from the results appended so far.
  write(): Promise<void>;
  // Adds a result and rewrites the file.
  append(result: ReplayResult): Promise<void>;
}

function sessionManifest(path: string, session: Omit<ReplaySession, "results">): SessionManifest {
  const results: ReplayResult[] = [];
  let tail: Promise<void> = Promise.resolve();
  const write = (): Promise<void> => {
    const next = tail.then(async () => {
      await writeFile(`${path}.tmp`, `${JSON.stringify({ ...session, results }, null, 2)}\n`);
      await rename(`${path}.tmp`, path);
    });
    tail = next;
    return next;
  };
  return {
    write,
    append: (result) => {
      results.push(result);
      return write();
    },
  };
}

// `width` workers over `items`. A failure stops further admission; the items
// already running finish before it propagates.
async function inPool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try {
        await work(item);
      } catch (err) {
        queue.length = 0;
        throw err;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(width, items.length) }, worker));
  const failed = settled.find((outcome) => outcome.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

type PreparedCase = PlannedRun & {
  readonly layout: RepoLayout;
  readonly stackSource: StackSource;
};

export type ReplayRunOptions = {
  readonly config: ResolvedConfig;
  readonly configPath: string;
  readonly casesFile: string;
  readonly label: string;
  readonly repeats: number;
  readonly parallel: number;
  readonly log: (line: string) => void;
};

// 0 when every case ran, 3 when a quota or credential stopped the session.
// A refusal throws a SandbarError before any token is spent.
export async function runReplay(opts: ReplayRunOptions): Promise<0 | 3> {
  const { config } = opts;
  const layout = replayLayout(config);
  await guardReplayProcess(layout.stateDir);
  const lockPaths = lockPathsFor(layout.stateDir);
  const release = await acquireLock(lockPaths);
  onCleanup(release);
  installCleanupTraps();
  try {
    return await runRepeats(opts, await prepareSession(opts, layout, realpathSync(lockPaths.workDir)));
  } finally {
    await runCleanup();
  }
}

// Everything `runRepeats` needs, after every refusal that can be made before a
// token is spent: the case file, the base cache, the host, the images, the
// session directory and each case's cache and stack.
type PreparedSession = {
  readonly driver: string;
  readonly stateDir: string;
  readonly sessionDir: string;
  readonly parallel: number;
  readonly manifest: SessionManifest;
  readonly repeats: readonly (readonly PreparedCase[])[];
  readonly branchImages: BranchImages;
  readonly issueConfigOf: (run: PreparedCase) => InnerLoopConfig;
};

async function prepareSession(
  opts: ReplayRunOptions,
  layout: RepoLayout,
  lockedWorkDir: string,
): Promise<PreparedSession> {
  const { config, log } = opts;
  const casesFile = resolve(opts.casesFile);
  const { cases, sha256 } = await readCases(casesFile, config);
  if (!existsSync(layout.repoDir)) {
    throw new SandbarError(`No replay base cache at ${layout.repoDir}; run \`replay freeze\` first.`);
  }
  const missing = await missingSeeds(layout.repoDir, cases.cases);
  if (missing.length > 0) {
    throw new SandbarError(`Seed(s) missing from ${layout.repoDir}; freeze again:\n${missing.join("\n")}`);
  }
  const sessionDir = join(layout.stateDir, "sessions", opts.label);
  if (existsSync(sessionDir)) throw new SandbarError(`Session ${sessionDir} already exists.`);
  const parallel = Math.min(opts.parallel, config.maxParallelIssues);
  const routing = replayRouting(config);
  log(renderReplayPlan({ label: opts.label, cases: cases.cases.length, repeats: opts.repeats, parallel, routing }));

  const space = await graphRootSpace(await podmanGraphRoot());
  if (graphRootSpaceIsLow(space)) throw new SandbarError(formatLowGraphRootSpace(space));

  const scope = runScope(lockedWorkDir);
  const providers = requiredAgentProviders(config);
  const sweep = await cleanupOrphanContainers(scope);
  for (const failure of sweep.failures) log(`replay: could not remove a leftover container:\n${failure}`);
  await reconcileImages({
    scope,
    liveTags: new Set([...config.images.map((image) => image.tag), ...agentToolsImageTags(scope, providers)]),
  });

  const env = makeEnvReader(config.env);
  const codexAuthMount = providers.includes("codex")
    ? await existingCodexAuth(repoLayout(config.cwd, config.workDir).stateDir, env("CODEX_HOME"))
    : undefined;
  const baseFingerprints = await existingBaseFingerprints(config.images);
  const agentImages = await createAgentImages({
    declaredBaseTag: config.sandboxImage,
    providers,
    ...(codexAuthMount === undefined ? {} : { codexHome: dirname(codexAuthMount.sandboxPath) }),
    scope,
    log,
  });

  const driver = formatDriverIdentity(await readDriverIdentity({ configPath: opts.configPath }));
  await mkdir(dirname(sessionDir), { recursive: true });
  await mkdir(sessionDir);
  const manifest = sessionManifest(join(sessionDir, "replay.json"), {
    replaySession: 1,
    label: opts.label,
    driver,
    casesFile,
    casesSha256: sha256,
    repeats: opts.repeats,
    parallel,
    routing,
    budgets: {
      maxQualityRounds: config.maxQualityRounds,
      maxGateRounds: config.maxGateRounds,
      maxReviewRounds: config.maxReviewRounds,
    },
  });
  await manifest.write();

  const hostUid = process.getuid?.() ?? 0;
  const plan = planReplay(cases.cases, opts.repeats);
  const repeats = await Promise.all(plan.map((repeat) => Promise.all(repeat.map(async (run): Promise<PreparedCase> => {
    const caseLayout = await prepareCaseCache({
      baseRepoDir: layout.repoDir,
      caseDir: join(sessionDir, "cases", `${run.case.issue}-r${run.repeat}`),
      hostCwd: config.cwd,
      sourceBranch: cases.sourceBranch,
      seedSha: run.case.seedSha,
    });
    const stackSource = await openStackSource({
      source: config.gateStack,
      repoDir: caseLayout.repoDir,
      sourceBranch: cases.sourceBranch,
      configEnv: config.env,
      images: config.images,
      sandboxImage: config.sandboxImage,
      databaseCopies: config.databaseCopies,
      // A case cache never moves, so the stack read here is the one every
      // gate of the case runs, checked below.
      hostChecks: (stack) => checkStackOnHost(stack, config.images, hostUid),
      onEvent: (event) => log(`replay: #${run.case.issue} ${event.kind}: ${"message" in event ? event.message : ""}`),
    });
    return { ...run, layout: caseLayout, stackSource };
  }))));
  const stacks = new Map(repeats.flat().map((c) => {
    const { stack } = c.stackSource.accepted();
    return [stackSpecToken(stack), stack] as const;
  }));
  await Promise.all([...stacks.values()].map((stack) => checkStackOnHost(stack, config.images, hostUid)));
  const mountingTags = new Set([...stacks.values()].flatMap((stack) => [...worktreeMountingTagsOf(stack)]));
  const branchImages = createBranchImages({
    images: config.images,
    scope,
    baseFingerprints,
    log,
    worktreeMountingTags: () => mountingTags,
    hostUid,
  });

  const sandboxEnv = stripForgeCredentials(sandboxEnvOf(config));
  return {
    driver,
    stateDir: layout.stateDir,
    sessionDir,
    parallel,
    manifest,
    repeats,
    branchImages,
    issueConfigOf: (run) => innerLoopConfigOf(config, {
      layout: run.layout,
      issueSource: async () => run.case.issueJson,
      scope,
      env: sandboxEnv,
      codexAuthMount,
      agentImages,
    }),
  };
}

async function runRepeats(opts: ReplayRunOptions, session: PreparedSession): Promise<0 | 3> {
  const { config, log } = opts;
  const { manifest } = session;
  let stopped: string | null = null;
  const notRun = (run: PlannedRun, record: string | null, reason: string): ReplayResult => ({
    repeat: run.repeat,
    run: record,
    issue: run.case.issue,
    seedSha: run.case.seedSha,
    branch: issueBranchName(run.case.issue, run.case.title),
    status: "not-run",
    reason,
  });

  for (const repeat of session.repeats) {
    // A repeat's record starts with its first case to run, so a repeat a stop
    // closed before it began leaves none (and its results name no run).
    const repeatRecord: {
      open: Promise<{ readonly record: EventRecord; readonly withdraw: () => void }> | null;
    } = { open: null };
    const gateSemaphore = createGateSemaphore(config.maxConcurrentGates);
    const providerState = createRunProviderState();
    await inPool(repeat, session.parallel, async (run) => {
      if (stopped !== null) {
        await manifest.append(notRun(run, repeatRecord.open === null ? null : basename((await repeatRecord.open).record.runDir), stopped));
        return;
      }
      repeatRecord.open ??= startEventRecord({
        baseDir: join(session.sessionDir, "logs"),
        start: {
          driver: session.driver,
          configPath: opts.configPath,
          workdir: session.stateDir,
          maxParallelIssues: session.parallel,
          pid: process.pid,
        },
      }).then((record) => ({ record, withdraw: registerDisposable(() => record.finalize("interrupted")) }));
      const { record } = await repeatRecord.open;
      const { result, stop } = await replayCase(run, {
        config,
        log,
        record,
        runName: basename(record.runDir),
        issueConfig: session.issueConfigOf(run),
        branchImages: session.branchImages,
        gateSemaphore,
        providerState,
      });
      stopped ??= stop;
      await manifest.append(result);
      log(`replay: r${run.repeat} #${run.case.issue} ${result.status === "ran" ? result.terminal : result.reason}`);
    });
    if (repeatRecord.open !== null) {
      const { record, withdraw } = await repeatRecord.open;
      await record.finalize(stopped === null ? "normal-exit" : "stopped");
      withdraw();
    }
  }
  return stopped === null ? 0 : 3;
}

type CaseContext = {
  readonly config: ResolvedConfig;
  readonly log: (line: string) => void;
  readonly record: EventRecord;
  readonly runName: string;
  readonly issueConfig: InnerLoopConfig;
  readonly branchImages: BranchImages;
  readonly gateSemaphore: GateSemaphore;
  readonly providerState: RunProviderState;
};

async function replayCase(
  run: PreparedCase,
  ctx: CaseContext,
): Promise<{ readonly result: ReplayResult; readonly stop: string | null }> {
  const { case: c, layout } = run;
  const issue = { id: String(c.issue), title: c.title, branch: issueBranchName(c.issue, c.title), chunk: null };
  const issueLogger = await ctx.record.issue(issue.id);
  let lastGateOk: boolean | null = null;
  const onEvent = async (event: EventInput): Promise<void> => {
    if (event.kind === "gate" && event.gate === "gate-1") lastGateOk = event.ok;
    await ctx.record.emit(event);
  };
  const timer = startTimer();
  let terminal: Terminal;
  try {
    terminal = await runInnerLoop(issue, {
      config: ctx.issueConfig,
      hooks: ctx.config.sandboxHooks,
      copyToWorktree: ctx.config.copyToWorktree,
      branchImages: ctx.branchImages,
      stackSource: run.stackSource,
      sandboxLogBaseDir: issueLogger.dir,
      attemptLogger: issueLogger,
      gateSemaphore: ctx.gateSemaphore,
      onEvent,
      providerState: ctx.providerState,
    });
  } catch (err) {
    // The clone stays where it is, for inspection.
    await ctx.record.emit(terminalEventOf(issue, rejectedEnding(err), timer()));
    throw err;
  }
  await ctx.record.emit(terminalEventOf(issue, terminal, timer()));
  // Publishes the clone's branch into the case cache, where it is kept.
  const reclaimed = await reclaimIssueClone(
    layout.repoDir,
    worktreePathFor(layout.worktreesDir, issue.branch),
    issue.branch,
  );
  if (reclaimed.kind === "preserved") {
    ctx.log(`replay: #${c.issue} clone kept at ${reclaimed.worktreePath}: ${reclaimed.reason}`);
  }
  const tip = (await gitStdout(layout.repoDir, ["rev-parse", `refs/heads/${issue.branch}`])).trim();
  return {
    stop: terminal.type === "QUOTA" || terminal.type === "CREDENTIAL"
      ? `${terminal.type}: ${terminalReason(terminal)}`
      : null,
    result: {
      repeat: run.repeat,
      run: ctx.runName,
      issue: c.issue,
      seedSha: c.seedSha,
      branch: issue.branch,
      status: "ran",
      terminal: terminal.type,
      tip,
      lastGateOk,
      diff: parseNumstat(await gitStdout(layout.repoDir, ["diff", "--numstat", c.seedSha, tip])),
    },
  };
}
