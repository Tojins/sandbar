// Repository-wide single-writer lease (#139).
//
// The workdir lock in lock.ts protects one host's disposable `.sandbar/`
// state. It cannot protect the refs shared by two hosts, so this module owns a
// second, independent lock: `refs/sandbar/lock` on origin. Any host may try to
// acquire it, but Git's ref transaction admits exactly one writer.
//
// The ref points at an orphan commit with an empty tree. Its JSON message is
// the whole lease: hostname, realpath'd workdir, pid, run stamp, start time and
// expiry. Acquire pushes with an expected-ABSENT force-with-lease; takeover
// expects the expired holder's exact sha; renewal expects our current sha; and
// release deletes only the sha we still hold. No operation uses an implicit
// tracking ref or an unconditional force.
//
// A failed push is not itself called contention. Git uses the same process
// failure channel for a lease rejection and for transport/server failures, and
// parsing human stderr would make correctness depend on Git's locale and
// version. Instead the adapter rereads the ref: a different sha is the only
// "someone else holds it" answer; our proposed sha recovers an acknowledged-
// late success; the expected old sha or an unavailable origin remains an I/O
// failure. The force-with-lease rejection, observed as that ref mismatch, is
// therefore the only contention signal.
//
// Expiry is judged against the taker's wall clock. Ten minutes deliberately
// dwarfs the scheduler's default one-minute wake cadence and absorbs ordinary
// clock skew. `decideAcquire`, `decideRenew` and `decideRelease` contain every
// ownership decision as pure functions over a ref lookup, a time and our
// claim. Failed-CAS reconciliation is pure too; the adapter only creates
// commits, executes returned CAS operations, and classifies the named
// `OriginLockCommandError` produced by its child-process boundary.
//
// A live run serializes all renewals through one guard: a one-minute heartbeat
// covers long gates and forge waits, every `ContinuousPool.waitForWake` result
// is a barrier before admission, and remote-write adapters renew immediately
// before a push or tracker mutation. If another host replaced the ref, or our
// lease is expired while origin cannot complete a renewal, the run must halt
// immediately. The orchestrator owns that terminal transition because it owns
// admissions, landings, clone preservation and the event record; this module
// returns a `lost` value carrying the only truthful holder description.
// `sandbar gate` never enters run.ts and takes neither daemon lock; it remains
// a standalone verdict command, not a repository writer.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { faultDetail, SandbarError } from "./errors.js";

const execFileAsync = promisify(execFile);

export const ORIGIN_LOCK_REF = "refs/sandbar/lock";
export const ORIGIN_LOCK_LEASE_MS = 10 * 60 * 1000;
export const ORIGIN_LOCK_RENEW_INTERVAL_MS = 60 * 1000;

// Every adapter capable of mutating origin or its tracker requires this
// capability explicitly. Daemon callers pass the serialized lease renewal;
// deliberate standalone/test callers pass an explicit no-op.
export type OriginWriteBarrier = () => Promise<void>;

export type OriginLockIdentity = {
  readonly hostname: string;
  readonly workdir: string;
  readonly pid: number;
  readonly run: string;
  readonly startedAt: string;
};

export type OriginLockLease = OriginLockIdentity & {
  readonly expires: string;
};

export type OriginLockClaim = {
  readonly sha: string;
  readonly lease: OriginLockLease;
};

export type OriginLockLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly claim: OriginLockClaim }
  | { readonly kind: "unavailable"; readonly reason: string };

export type AcquireDecision =
  | {
      readonly kind: "write";
      readonly expectedSha: string | null;
      readonly lease: OriginLockLease;
      readonly displaced: OriginLockClaim | null;
    }
  | { readonly kind: "refuse"; readonly holder: OriginLockClaim }
  | { readonly kind: "unavailable"; readonly reason: string };

export type RenewDecision =
  | {
      readonly kind: "write";
      readonly expectedSha: string;
      readonly lease: OriginLockLease;
    }
  | { readonly kind: "retained"; readonly reason: string }
  | {
      readonly kind: "lost";
      readonly holder: OriginLockClaim | null;
      readonly reason: "replaced" | "expired-unrenewable";
      readonly detail: string;
    };

export type ReleaseDecision =
  | { readonly kind: "delete"; readonly expectedSha: string }
  | { readonly kind: "released" }
  | { readonly kind: "unavailable"; readonly reason: string };

export type OriginLockRenewal =
  | { readonly kind: "renewed"; readonly claim: OriginLockClaim }
  | { readonly kind: "retained"; readonly claim: OriginLockClaim; readonly reason: string }
  | Extract<RenewDecision, { kind: "lost" }>;

export type OriginLockExec = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

// The only failures the adapter classifies as Git/transport outcomes. A test
// seam that throws an ordinary Error is a programming failure and propagates;
// the real process boundary converts child-process failures into this named
// condition before any lookup or CAS code sees them.
export class OriginLockCommandError extends SandbarError {
  readonly code: number | undefined;

  constructor(message: string, code?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "OriginLockCommandError";
    this.code = code;
  }
}

const realExec: OriginLockExec = async (file, args, options) => {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    const failure = cause as { code?: unknown; stderr?: unknown; message?: unknown };
    const detail = typeof failure.stderr === "string" && failure.stderr.trim()
      ? failure.stderr.trim()
      : typeof failure.message === "string"
        ? failure.message
        : String(cause);
    throw new OriginLockCommandError(
      `${file} ${args.join(" ")} failed: ${detail}`,
      typeof failure.code === "number" ? failure.code : undefined,
      cause,
    );
  }
};

const validDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function parseOriginLockLease(message: string): OriginLockLease {
  let value: unknown;
  try {
    value = JSON.parse(message.trim());
  } catch (cause) {
    throw new SandbarError(
      `Origin lock ${ORIGIN_LOCK_REF} has an invalid lease commit message. ` +
        "Refusing to guess whether it is safe to replace.",
      { cause },
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new SandbarError(`Origin lock ${ORIGIN_LOCK_REF} lease is not an object.`);
  }
  const lease = value as Record<string, unknown>;
  if (
    !nonEmptyString(lease["hostname"]) ||
    !nonEmptyString(lease["workdir"]) ||
    typeof lease["pid"] !== "number" ||
    !Number.isSafeInteger(lease["pid"]) ||
    lease["pid"] <= 0 ||
    !nonEmptyString(lease["run"]) ||
    !validDate(lease["startedAt"]) ||
    !validDate(lease["expires"])
  ) {
    throw new SandbarError(
      `Origin lock ${ORIGIN_LOCK_REF} has an incomplete or invalid lease. ` +
        "Refusing to guess whether it is safe to replace.",
    );
  }
  return {
    hostname: lease["hostname"],
    workdir: lease["workdir"],
    pid: lease["pid"],
    run: lease["run"],
    startedAt: lease["startedAt"],
    expires: lease["expires"],
  };
}

export const formatOriginLockHolder = (claim: OriginLockClaim): string => {
  const holder = claim.lease;
  return `${holder.hostname} pid ${holder.pid} in ${holder.workdir}, ` +
    `run ${holder.run} since ${holder.startedAt} (lease expires ${holder.expires})`;
};

const renewedLease = (
  identity: OriginLockIdentity,
  now: Date,
): OriginLockLease => ({
  ...identity,
  expires: new Date(now.getTime() + ORIGIN_LOCK_LEASE_MS).toISOString(),
});

const isExpired = (lease: OriginLockLease, now: Date): boolean =>
  Date.parse(lease.expires) <= now.getTime();

export function decideAcquire(
  lookup: OriginLockLookup,
  now: Date,
  identity: OriginLockIdentity,
): AcquireDecision {
  if (lookup.kind === "unavailable") return lookup;
  if (lookup.kind === "absent") {
    return {
      kind: "write",
      expectedSha: null,
      lease: renewedLease(identity, now),
      displaced: null,
    };
  }
  if (!isExpired(lookup.claim.lease, now)) {
    return { kind: "refuse", holder: lookup.claim };
  }
  return {
    kind: "write",
    expectedSha: lookup.claim.sha,
    lease: renewedLease(identity, now),
    displaced: lookup.claim,
  };
}

export function decideRenew(
  lookup: OriginLockLookup,
  now: Date,
  ours: OriginLockClaim,
): RenewDecision {
  if (lookup.kind === "unavailable") {
    return isExpired(ours.lease, now)
      ? {
          kind: "lost",
          holder: null,
          reason: "expired-unrenewable",
          detail: "origin could not be asked",
        }
      : { kind: "retained", reason: lookup.reason };
  }
  if (lookup.kind === "absent") {
    return {
      kind: "lost",
      holder: null,
      reason: "replaced",
      detail: `origin no longer has ${ORIGIN_LOCK_REF}`,
    };
  }
  if (lookup.claim.sha !== ours.sha) {
    return {
      kind: "lost",
      holder: lookup.claim,
      reason: "replaced",
      detail: `current holder is ${formatOriginLockHolder(lookup.claim)}`,
    };
  }
  return {
    kind: "write",
    expectedSha: ours.sha,
    lease: renewedLease(ours.lease, now),
  };
}

export function decideRelease(
  lookup: OriginLockLookup,
  ours: OriginLockClaim,
): ReleaseDecision {
  if (lookup.kind === "unavailable") return lookup;
  if (lookup.kind === "absent" || lookup.claim.sha !== ours.sha) {
    return { kind: "released" };
  }
  return { kind: "delete", expectedSha: ours.sha };
}

export type AcquirePushReconciliation =
  | { readonly kind: "acquired" }
  | { readonly kind: "refuse"; readonly holder: OriginLockClaim }
  | { readonly kind: "failed" };

export function decideAcquireAfterPushFailure(
  lookup: OriginLockLookup,
  expectedSha: string | null,
  proposed: OriginLockClaim,
): AcquirePushReconciliation {
  if (lookup.kind !== "found") return { kind: "failed" };
  if (lookup.claim.sha === proposed.sha) return { kind: "acquired" };
  return lookup.claim.sha !== expectedSha
    ? { kind: "refuse", holder: lookup.claim }
    : { kind: "failed" };
}

export function decideRenewAfterPushFailure(
  lookup: OriginLockLookup,
  now: Date,
  ours: OriginLockClaim,
  proposed: OriginLockClaim,
  failureReason: string,
): OriginLockRenewal {
  if (lookup.kind === "found" && lookup.claim.sha === proposed.sha) {
    return { kind: "renewed", claim: proposed };
  }
  const renewal = decideRenew(lookup, now, ours);
  if (renewal.kind === "lost") return renewal;
  if (renewal.kind === "retained") return { ...renewal, claim: ours };
  return isExpired(ours.lease, now)
    ? {
        kind: "lost",
        holder: lookup.kind === "found" ? lookup.claim : null,
        reason: "expired-unrenewable",
        detail: lookup.kind === "found"
          ? `current holder is ${formatOriginLockHolder(lookup.claim)}, ` +
            "but origin could not accept the renewal"
          : "origin could not accept the renewal",
      }
    : { kind: "retained", claim: ours, reason: failureReason };
}

export type ReleasePushReconciliation =
  | { readonly kind: "released" }
  | { readonly kind: "failed" };

export function decideReleaseAfterPushFailure(
  lookup: OriginLockLookup,
  ours: OriginLockClaim,
): ReleasePushReconciliation {
  return lookup.kind === "absent" ||
      (lookup.kind === "found" && lookup.claim.sha !== ours.sha)
    ? { kind: "released" }
    : { kind: "failed" };
}

export class OriginLockHeldError extends SandbarError {
  readonly holder: OriginLockClaim;

  constructor(holder: OriginLockClaim) {
    super(`Another sandbar daemon holds origin: ${formatOriginLockHolder(holder)}.`);
    this.name = "OriginLockHeldError";
    this.holder = holder;
  }
}

export type OriginLockHandle = {
  readonly claim: () => OriginLockClaim;
  renew(): Promise<OriginLockRenewal>;
  release(): Promise<void>;
};

type AcquireOriginLockOptions = {
  readonly repoDir: string;
  readonly identity: OriginLockIdentity;
  readonly now?: () => Date;
  readonly exec?: OriginLockExec;
};

async function lookupOriginLock(
  repoDir: string,
  exec: OriginLockExec,
  known: readonly OriginLockClaim[] = [],
): Promise<OriginLockLookup> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "git",
      ["ls-remote", "--exit-code", "origin", ORIGIN_LOCK_REF],
      { cwd: repoDir },
    ));
  } catch (err) {
    if (!(err instanceof OriginLockCommandError)) throw err;
    if (err.code === 2) return { kind: "absent" };
    return { kind: "unavailable", reason: faultDetail(err) };
  }
  const line = stdout.trim().split("\n")[0];
  const sha = line?.trim().split(/\s+/)[0];
  if (!sha) {
    return {
      kind: "unavailable",
      reason: `Origin returned no sha for ${ORIGIN_LOCK_REF}`,
    };
  }
  const knownClaim = known.find((claim) => claim.sha === sha);
  if (knownClaim) return { kind: "found", claim: knownClaim };
  try {
    // Fetch the ref, not the sha observed milliseconds earlier. Renewal
    // commits are orphaned, so once the ref moves the old object may no longer
    // be fetchable by object id. FETCH_HEAD gives us the coherent fetch-time
    // holder even when it moved between ls-remote and this command.
    await exec("git", ["fetch", "--quiet", "origin", ORIGIN_LOCK_REF], {
      cwd: repoDir,
    });
    const fetched = await exec("git", ["rev-parse", "FETCH_HEAD"], {
      cwd: repoDir,
    });
    const fetchedSha = fetched.stdout.trim();
    const fetchedKnown = known.find((claim) => claim.sha === fetchedSha);
    if (fetchedKnown) return { kind: "found", claim: fetchedKnown };
    const message = await exec(
      "git",
      ["show", "-s", "--format=%B", fetchedSha],
      { cwd: repoDir },
    );
    return {
      kind: "found",
      claim: { sha: fetchedSha, lease: parseOriginLockLease(message.stdout) },
    };
  } catch (err) {
    if (err instanceof OriginLockCommandError) {
      return { kind: "unavailable", reason: faultDetail(err) };
    }
    throw err;
  }
}

async function createLeaseCommit(
  repoDir: string,
  lease: OriginLockLease,
  exec: OriginLockExec,
): Promise<OriginLockClaim> {
  const tree = await exec(
    "git",
    ["hash-object", "-t", "tree", "/dev/null"],
    { cwd: repoDir },
  );
  const message = JSON.stringify(lease);
  const commit = await exec(
    "git",
    ["commit-tree", tree.stdout.trim(), "-m", message],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "sandbar",
        GIT_AUTHOR_EMAIL: "sandbar@localhost",
        GIT_COMMITTER_NAME: "sandbar",
        GIT_COMMITTER_EMAIL: "sandbar@localhost",
        GIT_AUTHOR_DATE: lease.startedAt,
        GIT_COMMITTER_DATE: lease.startedAt,
      },
    },
  );
  const sha = commit.stdout.trim();
  if (!sha) throw new SandbarError("git commit-tree returned no origin lease sha");
  return { sha, lease };
}

const pushArgs = (claim: OriginLockClaim, expectedSha: string | null): string[] => [
  "push",
  "--porcelain",
  `--force-with-lease=${ORIGIN_LOCK_REF}:${expectedSha ?? ""}`,
  "origin",
  `${claim.sha}:${ORIGIN_LOCK_REF}`,
];

const deleteArgs = (expectedSha: string): string[] => [
  "push",
  "--porcelain",
  `--force-with-lease=${ORIGIN_LOCK_REF}:${expectedSha}`,
  "origin",
  `:${ORIGIN_LOCK_REF}`,
];

async function pushClaim(
  repoDir: string,
  claim: OriginLockClaim,
  expectedSha: string | null,
  exec: OriginLockExec,
): Promise<OriginLockCommandError | null> {
  try {
    await exec("git", pushArgs(claim, expectedSha), { cwd: repoDir });
    return null;
  } catch (err) {
    if (!(err instanceof OriginLockCommandError)) throw err;
    return err;
  }
}

export async function acquireOriginLock(
  options: AcquireOriginLockOptions,
): Promise<{ readonly lock: OriginLockHandle; readonly displaced: OriginLockClaim | null }> {
  const exec = options.exec ?? realExec;
  const clock = options.now ?? (() => new Date());
  const initial = await lookupOriginLock(options.repoDir, exec);
  const decision = decideAcquire(initial, clock(), options.identity);
  if (decision.kind === "unavailable") {
    throw new SandbarError(`Could not read origin lock: ${decision.reason}`);
  }
  if (decision.kind === "refuse") throw new OriginLockHeldError(decision.holder);

  const proposed = await createLeaseCommit(options.repoDir, decision.lease, exec);
  const pushFailure = await pushClaim(
    options.repoDir,
    proposed,
    decision.expectedSha,
    exec,
  );
  if (pushFailure !== null) {
    const observed = await lookupOriginLock(
      options.repoDir,
      exec,
      [proposed, ...(initial.kind === "found" ? [initial.claim] : [])],
    );
    const reconciliation = decideAcquireAfterPushFailure(
      observed,
      decision.expectedSha,
      proposed,
    );
    if (reconciliation.kind === "refuse") {
      throw new OriginLockHeldError(reconciliation.holder);
    }
    if (reconciliation.kind === "failed") {
      throw new SandbarError(
        `Could not update origin lock ${ORIGIN_LOCK_REF}.`,
        { cause: pushFailure },
      );
    }
  }

  let current = proposed;
  let active = true;
  const lock: OriginLockHandle = {
    claim: () => current,
    async renew() {
      if (!active) {
        return {
          kind: "lost",
          holder: null,
          reason: "replaced",
          detail: "this process no longer owns an active origin lease",
        };
      }
      const observed = await lookupOriginLock(options.repoDir, exec, [current]);
      const renewal = decideRenew(observed, clock(), current);
      if (renewal.kind !== "write") {
        if (renewal.kind === "lost") active = false;
        return renewal.kind === "retained"
          ? { ...renewal, claim: current }
          : renewal;
      }
      const next = await createLeaseCommit(options.repoDir, renewal.lease, exec);
      const failure = await pushClaim(options.repoDir, next, renewal.expectedSha, exec);
      if (failure === null) {
        current = next;
        return { kind: "renewed", claim: current };
      }

      const after = await lookupOriginLock(options.repoDir, exec, [current, next]);
      // Sample after every failed push and reread. A renewal begun before
      // expiry cannot retain a lease that expired while Git was failing.
      const resolved = decideRenewAfterPushFailure(
        after,
        clock(),
        current,
        next,
        faultDetail(failure),
      );
      if (resolved.kind === "renewed") current = resolved.claim;
      if (resolved.kind === "lost") active = false;
      return resolved;
    },
    async release() {
      if (!active) return;
      const observed = await lookupOriginLock(options.repoDir, exec, [current]);
      const release = decideRelease(observed, current);
      if (release.kind === "released") {
        active = false;
        return;
      }
      if (release.kind === "unavailable") {
        throw new SandbarError(`Could not read origin lock for release: ${release.reason}`);
      }
      try {
        await exec("git", deleteArgs(release.expectedSha), { cwd: options.repoDir });
        active = false;
      } catch (cause) {
        if (!(cause instanceof OriginLockCommandError)) throw cause;
        const after = await lookupOriginLock(options.repoDir, exec, [current]);
        if (decideReleaseAfterPushFailure(after, current).kind === "released") {
          active = false;
          return;
        }
        throw new SandbarError(`Could not release origin lock ${ORIGIN_LOCK_REF}.`, { cause });
      }
    },
  };
  return { lock, displaced: decision.displaced };
}
