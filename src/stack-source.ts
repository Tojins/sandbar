// Where a gate stack comes from when the config names a file (#186).
//
// The gate is the grader, and a branch that could edit its grader could widen
// its own mounts or weaken a check until it passes. So the stack DEFINITION —
// containers, env, mounts, steps — comes from the source branch, while the
// images built from the branch's Containerfiles are part of the work under
// test (`createBranchImages`, #37).
//
// `gateStack: { path }` is read from the bare cache's
// `refs/remotes/origin/<sourceBranch>` as last fetched, whenever a stack is
// resolved: every planning cycle and every landing refresh that ref, so no
// fetch is added per gate, and a landed stack change reaches the next gate
// without a restart. Reading the operator's clone instead is the stale-stack
// defect #186 was filed for. The inline form lives in the installation, is
// resolved at load, and is returned as it is.
//
// ACCEPTANCE. `openStackSource` runs at startup, after preflight's fetch, and
// a tip with no valid stack there refuses the run, as a bad config does. Its
// host checks are preflight's invariants and the uid check after the image
// builds, so they are not repeated here. Inside the run, a NEW tip blob is
// accepted only once it validates and passes those same host checks
// (`hostChecks`: pulled images present, absolute mount sources readable, D3's
// uid rule). A tip that fails leaves the run on the last accepted stack and
// raises one complaint per blob; the failure is not cached, so a tip that
// becomes acceptable — the play has pulled its new image — is taken at the
// next resolution. Halting instead would wait on a consumer landing that a
// halted daemon never picks up.
//
// A BRANCH'S OWN FILE (`forHead`). Each issue's stack in effect is the
// accepted tip stack, with the branch's container `env` laid over it when the
// branch's file differs only in env; any other difference, and a missing or
// invalid file, is a `non-env` change the inner loop parks on
// (stack-change.ts owns that rule). The branch's file is compared only when the
// branch CHANGED it — when it differs from the file at the branch's fork from
// `refs/remotes/origin/<sourceBranch>`. Otherwise a stack change landed on the
// source after the branch was cut would read as the branch's own edit: every
// in-flight issue would park on a change it never made, and an env-only one
// would be reverted by the branch's stale env. The fork is asked of the tree
// `forHead` is handed, whose remote-tracking ref only has to reach the fork.
//
// `sandbar gate` and `pulled-images` read the file from a tree on disk
// (`readStackFrom`): they have no cache and are run by a human, and a CI job
// grading its own PR is the one place a branch is meant to see its own stack.
//
// `BoundStack` keeps a running gate stack bound to the spec it was started
// for. Inside a run nothing reuses a stack across specs, so "a changed stack
// recreates its containers" is enforced here: `ensure` with a spec whose token
// differs stops the stack and starts it again. A rare stack change costs one
// full restart, which is cheaper than lifecycle logic to recreate only the
// containers that changed, since the steps are captured at start as well.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalSha256 } from "./canonical-json.js";
import {
  type BuiltImage,
  type ResolvedGateStack,
  type ResolvedStack,
  type ResolvedStackSource,
  checkRebuildOnIsUsed,
  resolveStackFile,
} from "./config.js";
import { SandbarError, isErrno, isExitCode } from "./errors.js";
import type { EventInput } from "./events.js";
import { type Stack, type StackOptions, startStack } from "./gate-stack.js";
import {
  type BranchStackRead,
  type StackInEffect,
  stackInEffect,
} from "./stack-change.js";

const exec = promisify(execFile);

export type StackSource = {
  // The stack the next gate runs: the tip's when it is accepted, the last
  // accepted one when it is not.
  readonly current: () => Promise<ResolvedStack>;
  // The last accepted stack, without reading the tip.
  readonly accepted: () => ResolvedStack;
  // The file a branch may edit, or null for an inline stack, which lives in
  // the installation where no branch reaches it.
  readonly path: string | null;
  // The stack in effect for commit `head` of the tree at `worktree`: what
  // `current` returns, with the branch's env laid over it where that is all
  // the branch changed.
  readonly forHead: (worktree: string, head: string) => Promise<HeadStack>;
};

// `tipBlob` is the accepted tip stack's blob, null for an inline stack.
export type HeadStack = StackInEffect & { readonly tipBlob: string | null };

export type StackSourceOptions = {
  readonly source: ResolvedStackSource;
  // The bare cache, whose `refs/remotes/origin/<sourceBranch>` is the tip.
  readonly repoDir: string;
  readonly sourceBranch: string;
  // `config.env`, which a step container's env must not collide with (#166).
  readonly configEnv: Readonly<Record<string, string>>;
  // What `checkRebuildOnIsUsed` asks of every stack this source accepts, the
  // inline one included: a stack is not known until it is read.
  readonly images: readonly BuiltImage[];
  readonly sandboxImage: string;
  // The host checks a new tip has to pass. Throws a SandbarError saying what
  // fails.
  readonly hostChecks: (stack: ResolvedGateStack) => Promise<void>;
  readonly onEvent: (event: EventInput) => Promise<void> | void;
};

// Which repository a git call runs in: `--git-dir` for the bare cache, `-C`
// for a worktree.
type Repo = readonly string[];

// The blob at `<rev>:<path>`, or null when the rev or the path is absent.
async function blobAt(
  repo: Repo,
  rev: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec("git", [
      ...repo, "rev-parse", "--verify", "--quiet", `${rev}:${path}`,
    ]);
    return stdout.trim();
  } catch (err) {
    // `--quiet` makes an unresolvable name exit 1 and say nothing.
    if (isExitCode(err, 1)) return null;
    throw err;
  }
}

// The commit `head` forked from `ref` at, or null when they share none.
async function forkPoint(
  repo: Repo,
  head: string,
  ref: string,
): Promise<string | null> {
  try {
    return (await exec("git", [...repo, "merge-base", head, ref])).stdout.trim();
  } catch (err) {
    if (isExitCode(err, 1)) return null;
    throw err;
  }
}

async function readStackBlob(
  repo: Repo,
  blob: string | null,
  label: string,
  configEnv: Readonly<Record<string, string>>,
): Promise<ResolvedStack> {
  if (blob === null) throw new SandbarError(`${label}: no such file.`);
  const git = (...args: string[]) => exec("git", [...repo, "cat-file", ...args]);
  // The type is asked apart from the read so a directory at the path is named
  // as one rather than failing as a bad object.
  const type = (await git("-t", blob)).stdout.trim();
  if (type !== "blob") {
    throw new SandbarError(`${label}: is a ${type}, not a file.`);
  }
  return resolveStackFile((await git("blob", blob)).stdout, label, configEnv);
}

// The source a run starts on. Throws a SandbarError when the tip has no valid
// stack; preflight reports it as a refusal.
export async function openStackSource(
  opts: StackSourceOptions,
): Promise<StackSource> {
  const { source } = opts;
  const checkImages = (resolved: ResolvedStack) =>
    checkRebuildOnIsUsed(opts.images, resolved.stack, opts.sandboxImage);
  if (source.kind === "inline") {
    checkImages(source);
    return {
      current: async () => source,
      accepted: () => source,
      path: null,
      forHead: async () => ({
        stack: source.stack,
        attachments: source.attachments,
        classification: { kind: "same" },
        tipBlob: null,
      }),
    };
  }
  const { path } = source;
  const cache: Repo = ["--git-dir", opts.repoDir];
  const ref = `refs/remotes/origin/${opts.sourceBranch}`;
  const label = `${path} at origin/${opts.sourceBranch}`;
  const read = async (blob: string | null) => {
    const resolved = await readStackBlob(cache, blob, label, opts.configEnv);
    checkImages(resolved);
    return resolved;
  };

  const startBlob = await blobAt(cache, ref, path);
  let accepted = { blob: startBlob, resolved: await read(startBlob) };
  // Keyed by blob, so a tip that is fixed and broken again is reported again.
  const complained = new Set<string | null>();

  // The accepted tip stack after reading the tip again, and its blob.
  const refresh = async (): Promise<typeof accepted> => {
    const blob = await blobAt(cache, ref, path);
    if (blob === accepted.blob) return accepted;
    let resolved: ResolvedStack;
    try {
      resolved = await read(blob);
      await opts.hostChecks(resolved.stack);
    } catch (err) {
      if (!(err instanceof SandbarError)) throw err;
      if (!complained.has(blob)) {
        complained.add(blob);
        await opts.onEvent({
          kind: "complaint",
          severity: "warning",
          message:
            `Gate stack: ${label} was not accepted` +
            (blob === null ? "" : ` (blob ${blob})`) +
            ", so gates keep running the last accepted stack " +
            `(blob ${accepted.blob}):\n${err.message}`,
        });
      }
      return accepted;
    }
    accepted = { blob, resolved };
    await opts.onEvent({
      kind: "notice",
      message: `Gate stack: accepted ${label} (blob ${blob}); the next gate runs it.`,
    });
    return accepted;
  };

  // What the branch made of its file: null when it did not change it since
  // its fork from the source, which leaves the tip's stack in effect.
  const branchRead = async (
    worktree: Repo,
    head: string,
    tipBlob: string | null,
  ): Promise<BranchStackRead | null> => {
    const blob = await blobAt(worktree, head, path);
    if (blob === tipBlob) return null;
    const fork = await forkPoint(worktree, head, ref);
    if (fork !== null && blob === (await blobAt(worktree, fork, path))) return null;
    if (blob === null) return { kind: "missing" };
    try {
      const { stack } = await readStackBlob(worktree, blob, `${path} at ${head}`, opts.configEnv);
      return { kind: "ok", stack };
    } catch (err) {
      if (!(err instanceof SandbarError)) throw err;
      return { kind: "invalid", message: err.message };
    }
  };

  return {
    accepted: () => accepted.resolved,
    current: async () => (await refresh()).resolved,
    path,
    forHead: async (worktree, head) => {
      const tip = await refresh();
      const branch = await branchRead(["-C", worktree], head, tip.blob);
      return {
        ...(branch === null
          ? { ...tip.resolved, classification: { kind: "same" } as const }
          : stackInEffect(path, tip.resolved, branch, opts.configEnv)),
        tipBlob: tip.blob,
      };
    },
  };
}

// The stack for a tree on disk: `sandbar gate` reads the tree it gates, and
// `pulled-images` reads the clone the play has just updated.
export async function readStackFrom(
  source: ResolvedStackSource,
  root: string,
  configEnv: Readonly<Record<string, string>>,
): Promise<ResolvedStack> {
  if (source.kind === "inline") return source;
  const file = join(root, source.path);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    throw new SandbarError(
      `${file}: no such file (config.gateStack names "${source.path}").`,
    );
  }
  return resolveStackFile(text, file, configEnv);
}

// What a running stack is a stack OF. Over the canonical form, so the same
// stack spelled in another key order is the same token.
export function stackSpecToken(spec: ResolvedGateStack): string {
  return canonicalSha256(spec);
}

export type BoundStack = {
  // The running stack for `spec`: the one already up when it was started for
  // the same spec, else a fresh one started after the old one stopped.
  readonly ensure: (spec: ResolvedGateStack) => Promise<Stack>;
  readonly stop: () => Promise<void>;
};

export async function bindStack(
  opts: Omit<StackOptions, "spec">,
  spec: ResolvedGateStack,
): Promise<BoundStack> {
  let token: string | null = stackSpecToken(spec);
  let stack = await startStack({ ...opts, spec });
  return {
    ensure: async (next) => {
      const nextToken = stackSpecToken(next);
      if (nextToken === token) return stack;
      // The old stack is stopped, so no token describes what is running until
      // the new start completes: a start that throws leaves `null`, and every
      // later `ensure` — whichever spec — starts again.
      token = null;
      await stack.stop();
      stack = await startStack({ ...opts, spec: next });
      token = nextToken;
      return stack;
    },
    stop: () => stack.stop(),
  };
}
