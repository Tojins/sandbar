import { describe, expect, it } from "vitest";

import {
  ORIGIN_LOCK_LEASE_MS,
  ORIGIN_LOCK_OBSERVED_REF,
  ORIGIN_LOCK_REF,
  OriginLockCommandError,
  OriginLockHeldError,
  acquireOriginLock,
  decideAcquire,
  decideAcquireAfterPushFailure,
  decideRelease,
  decideReleaseAfterPushFailure,
  decideRenew,
  decideRenewAfterPushFailure,
  parseOriginLockLease,
  type OriginLockClaim,
  type OriginLockExec,
  type OriginLockIdentity,
} from "./origin-lock.js";

const identity: OriginLockIdentity = {
  hostname: "host-a",
  workdir: "/srv/app/.sandbar",
  pid: 123,
  run: "2026-09-08T12-00-00-000Z",
  startedAt: "2026-09-08T12:00:00.000Z",
};
const now = new Date(identity.startedAt);
const claim = (over: Partial<OriginLockClaim["lease"]> = {}): OriginLockClaim => ({
  sha: "old-sha",
  lease: {
    ...identity,
    expires: new Date(now.getTime() + ORIGIN_LOCK_LEASE_MS).toISOString(),
    ...over,
  },
});
const commandError = (message: string, code?: number): OriginLockCommandError =>
  new OriginLockCommandError(message, code);

describe("origin lock decisions (#139)", () => {
  it("acquires only against an absent ref", () => {
    expect(decideAcquire({ kind: "absent" }, now, identity)).toEqual({
      kind: "write",
      expectedSha: null,
      lease: {
        ...identity,
        expires: "2026-09-08T12:10:00.000Z",
      },
      displaced: null,
    });
  });

  it("refuses a live holder and names the whole claim", () => {
    const holder = claim();
    expect(decideAcquire({ kind: "found", claim: holder }, now, identity))
      .toEqual({ kind: "refuse", holder });
  });

  it("takes an expired holder over by its exact sha", () => {
    const holder = claim({ expires: now.toISOString() });
    expect(decideAcquire({ kind: "found", claim: holder }, now, identity))
      .toMatchObject({
        kind: "write",
        expectedSha: "old-sha",
        displaced: holder,
      });
  });

  it("renews our exact sha and rejects a replacement", () => {
    const ours = claim();
    expect(decideRenew({ kind: "found", claim: ours }, now, ours)).toMatchObject({
      kind: "write",
      expectedSha: ours.sha,
    });
    const replacement = { ...claim({ hostname: "host-b" }), sha: "new-sha" };
    expect(decideRenew({ kind: "found", claim: replacement }, now, ours))
      .toMatchObject({ kind: "lost", reason: "replaced", holder: replacement });
  });

  it("retains an unexpired lease through an outage, then loses it at expiry", () => {
    const ours = claim();
    const unavailable = { kind: "unavailable" as const, reason: "network down" };
    expect(decideRenew(unavailable, now, ours)).toEqual({
      kind: "retained",
      reason: "network down",
    });
    expect(decideRenew(
      unavailable,
      new Date(ours.lease.expires),
      ours,
    )).toEqual({
      kind: "lost",
      holder: null,
      reason: "expired-unrenewable",
      detail: "origin could not be asked",
    });
  });

  it("deletes only our observed sha", () => {
    const ours = claim();
    expect(decideRelease({ kind: "found", claim: ours }, ours))
      .toEqual({ kind: "delete", expectedSha: ours.sha });
    expect(decideRelease({
      kind: "found",
      claim: { ...ours, sha: "replacement" },
    }, ours)).toEqual({ kind: "released" });
  });

  it("reconciles failed acquire, renew and release CAS outcomes purely", () => {
    const ours = claim();
    const proposed = { ...claim(), sha: "proposed-sha" };
    const replacement = { ...claim({ hostname: "host-b" }), sha: "replacement-sha" };
    expect(decideAcquireAfterPushFailure(
      { kind: "found", claim: proposed }, null, proposed,
    )).toEqual({ kind: "acquired" });
    expect(decideAcquireAfterPushFailure(
      { kind: "found", claim: replacement }, null, proposed,
    )).toEqual({ kind: "refuse", holder: replacement });
    expect(decideAcquireAfterPushFailure(
      { kind: "unavailable", reason: "offline" }, null, proposed,
    )).toEqual({ kind: "failed" });

    expect(decideRenewAfterPushFailure(
      { kind: "found", claim: proposed }, now, ours, proposed, "push failed",
    )).toEqual({ kind: "renewed", claim: proposed });
    expect(decideRenewAfterPushFailure(
      { kind: "found", claim: replacement }, now, ours, proposed, "push failed",
    )).toMatchObject({ kind: "lost", reason: "replaced", holder: replacement });
    expect(decideRenewAfterPushFailure(
      { kind: "found", claim: ours }, now, ours, proposed, "push failed",
    )).toEqual({ kind: "retained", claim: ours, reason: "push failed" });
    expect(decideRenewAfterPushFailure(
      { kind: "unavailable", reason: "offline" },
      new Date(ours.lease.expires), ours, proposed, "push failed",
    )).toMatchObject({ kind: "lost", reason: "expired-unrenewable" });

    expect(decideReleaseAfterPushFailure({ kind: "absent" }, ours))
      .toEqual({ kind: "released" });
    expect(decideReleaseAfterPushFailure(
      { kind: "found", claim: replacement }, ours,
    )).toEqual({ kind: "released" });
    expect(decideReleaseAfterPushFailure(
      { kind: "found", claim: ours }, ours,
    )).toEqual({ kind: "failed" });
    expect(decideReleaseAfterPushFailure(
      { kind: "unavailable", reason: "offline" }, ours,
    )).toEqual({ kind: "failed" });
  });

  it.each([
    ["invalid JSON", "not json"],
    ["null", "null"],
    ["array", "[]"],
    ["missing hostname", JSON.stringify({ ...claim().lease, hostname: undefined })],
    ["blank hostname", JSON.stringify({ ...claim().lease, hostname: " " })],
    ["non-string hostname", JSON.stringify({ ...claim().lease, hostname: 1 })],
    ["missing workdir", JSON.stringify({ ...claim().lease, workdir: undefined })],
    ["non-string workdir", JSON.stringify({ ...claim().lease, workdir: 1 })],
    ["missing pid", JSON.stringify({ ...claim().lease, pid: undefined })],
    ["zero pid", JSON.stringify({ ...claim().lease, pid: 0 })],
    ["fractional pid", JSON.stringify({ ...claim().lease, pid: 1.5 })],
    ["non-number pid", JSON.stringify({ ...claim().lease, pid: "1" })],
    ["missing run", JSON.stringify({ ...claim().lease, run: undefined })],
    ["non-string run", JSON.stringify({ ...claim().lease, run: 1 })],
    ["missing startedAt", JSON.stringify({ ...claim().lease, startedAt: undefined })],
    ["invalid startedAt", JSON.stringify({ ...claim().lease, startedAt: "soon" })],
    ["non-string startedAt", JSON.stringify({ ...claim().lease, startedAt: 1 })],
    ["missing expires", JSON.stringify({ ...identity })],
    ["invalid expires", JSON.stringify({ ...claim().lease, expires: "later" })],
    ["non-string expires", JSON.stringify({ ...claim().lease, expires: 1 })],
  ])("fails closed on a %s lease commit", (_name, message) => {
    expect(() => parseOriginLockLease(message)).toThrow(/Origin lock/);
  });
});

type ExecCall = {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
};

describe("origin lock git argv (#139)", () => {
  const leaseExec = (options: {
    readonly onSecondPush?: (state: { remoteSha: string | null }) =>
      { readonly remoteSha: string | null; readonly error?: OriginLockCommandError };
    readonly rereadUnavailable?: boolean;
    readonly replacement?: OriginLockClaim;
  } = {}) => {
    let remoteSha: string | null = null;
    let nextCommit = 0;
    let pushes = 0;
    const exec: OriginLockExec = async (_file, args) => {
      if (args[0] === "ls-remote") {
        if (options.rereadUnavailable && pushes >= 2) {
          throw commandError("origin offline");
        }
        if (remoteSha === null) throw commandError("absent", 2);
        return { stdout: `${remoteSha}\t${ORIGIN_LOCK_REF}\n`, stderr: "" };
      }
      if (args[0] === "fetch") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${remoteSha}\n`, stderr: "" };
      if (args[0] === "show" && options.replacement) {
        return { stdout: JSON.stringify(options.replacement.lease), stderr: "" };
      }
      if (args[0] === "hash-object") return { stdout: "tree\n", stderr: "" };
      if (args[0] === "commit-tree") {
        nextCommit += 1;
        return { stdout: `commit-${nextCommit}\n`, stderr: "" };
      }
      if (args[0] === "push") {
        pushes += 1;
        const refspec = args.at(-1)!;
        const proposed = refspec === `:${ORIGIN_LOCK_REF}`
          ? null
          : refspec.split(":")[0]!;
        if (pushes === 2 && options.onSecondPush) {
          const result = options.onSecondPush({ remoteSha });
          remoteSha = result.remoteSha;
          if (result.error) throw result.error;
          return { stdout: "", stderr: "" };
        }
        remoteSha = proposed;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    return { exec, remoteSha: () => remoteSha };
  };

  it("uses explicit CAS argv for acquire, renew and release", async () => {
    const calls: ExecCall[] = [];
    let remoteSha: string | null = null;
    let nextCommit = 0;
    let clockMs = now.getTime();
    const exec: OriginLockExec = async (file, args, options) => {
      calls.push({ file, args: [...args], cwd: options.cwd });
      if (args[0] === "ls-remote") {
        if (remoteSha === null) {
          throw commandError("no ref", 2);
        }
        return { stdout: `${remoteSha}\t${ORIGIN_LOCK_REF}\n`, stderr: "" };
      }
      if (args[0] === "hash-object") {
        return { stdout: "empty-tree\n", stderr: "" };
      }
      if (args[0] === "commit-tree") {
        nextCommit += 1;
        return { stdout: `commit-${nextCommit}\n`, stderr: "" };
      }
      if (args[0] === "push") {
        const refspec = args.at(-1);
        remoteSha = refspec === `:${ORIGIN_LOCK_REF}`
          ? null
          : refspec?.split(":")[0] ?? null;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    const acquired = await acquireOriginLock({
      repoDir: "/cache.git",
      identity,
      now: () => new Date(clockMs),
      exec,
    });
    expect(calls.find((call) => call.args[0] === "push")?.args).toEqual([
      "push",
      "--porcelain",
      `--force-with-lease=${ORIGIN_LOCK_REF}:`,
      "origin",
      `commit-1:${ORIGIN_LOCK_REF}`,
    ]);

    clockMs += 60_000;
    await acquired.lock.renew();
    const pushes = calls.filter((call) => call.args[0] === "push");
    expect(pushes[1]?.args).toEqual([
      "push",
      "--porcelain",
      `--force-with-lease=${ORIGIN_LOCK_REF}:commit-1`,
      "origin",
      `commit-2:${ORIGIN_LOCK_REF}`,
    ]);

    await acquired.lock.release();
    expect(calls.filter((call) => call.args[0] === "push")[2]?.args).toEqual([
      "push",
      "--porcelain",
      `--force-with-lease=${ORIGIN_LOCK_REF}:commit-2`,
      "origin",
      `:${ORIGIN_LOCK_REF}`,
    ]);
    expect(calls.every((call) => call.file === "git" && call.cwd === "/cache.git"))
      .toBe(true);
  });

  it("uses the expired holder's exact sha for takeover", async () => {
    const holder = claim({ expires: now.toISOString() });
    const calls: ExecCall[] = [];
    const exec: OriginLockExec = async (file, args, options) => {
      calls.push({ file, args: [...args], cwd: options.cwd });
      if (args[0] === "ls-remote") {
        return { stdout: `${holder.sha}\t${ORIGIN_LOCK_REF}\n`, stderr: "" };
      }
      if (args[0] === "fetch") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${holder.sha}\n`, stderr: "" };
      if (args[0] === "show") {
        return { stdout: JSON.stringify(holder.lease), stderr: "" };
      }
      if (args[0] === "hash-object") return { stdout: "tree\n", stderr: "" };
      if (args[0] === "commit-tree") return { stdout: "takeover\n", stderr: "" };
      if (args[0] === "push") return { stdout: "", stderr: "" };
      throw new Error("unexpected command");
    };

    const acquired = await acquireOriginLock({
      repoDir: "/cache",
      identity,
      now: () => now,
      exec,
    });
    expect(acquired.displaced).toEqual(holder);
    expect(calls.find((call) => call.args[0] === "push")?.args).toEqual([
      "push",
      "--porcelain",
      `--force-with-lease=${ORIGIN_LOCK_REF}:${holder.sha}`,
      "origin",
      `takeover:${ORIGIN_LOCK_REF}`,
    ]);
    expect(calls.find((call) => call.args[0] === "fetch")?.args).toEqual([
      "fetch",
      "--quiet",
      "origin",
      `+${ORIGIN_LOCK_REF}:${ORIGIN_LOCK_OBSERVED_REF}`,
    ]);
    expect(calls.find((call) => call.args[0] === "rev-parse")?.args).toEqual([
      "rev-parse",
      ORIGIN_LOCK_OBSERVED_REF,
    ]);
  });

  it("classifies a failed absent-CAS only after observing the winner", async () => {
    const winner = claim({ hostname: "host-b" });
    let lookup = 0;
    const exec: OriginLockExec = async (_file, args) => {
      if (args[0] === "ls-remote") {
        lookup += 1;
        if (lookup === 1) throw commandError("absent", 2);
        return { stdout: `${winner.sha}\t${ORIGIN_LOCK_REF}\n`, stderr: "" };
      }
      if (args[0] === "fetch") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${winner.sha}\n`, stderr: "" };
      if (args[0] === "show") {
        return { stdout: JSON.stringify(winner.lease), stderr: "" };
      }
      if (args[0] === "hash-object") return { stdout: "tree\n", stderr: "" };
      if (args[0] === "commit-tree") return { stdout: "ours\n", stderr: "" };
      if (args[0] === "push") throw commandError("push failed");
      throw new Error("unexpected command");
    };

    await expect(acquireOriginLock({ repoDir: "/cache", identity, exec }))
      .rejects.toBeInstanceOf(OriginLockHeldError);
  });

  it.each(["acknowledged-late", "absent", "unavailable"] as const)(
    "reconciles an $shape failed acquisition CAS",
    async (shape) => {
      let remoteSha: string | null = null;
      let lookups = 0;
      const exec: OriginLockExec = async (_file, args) => {
        if (args[0] === "ls-remote") {
          lookups += 1;
          if (lookups === 1 || shape === "absent") throw commandError("absent", 2);
          if (shape === "unavailable") throw commandError("offline");
          return { stdout: `${remoteSha}\t${ORIGIN_LOCK_REF}\n`, stderr: "" };
        }
        if (args[0] === "hash-object") return { stdout: "tree\n", stderr: "" };
        if (args[0] === "commit-tree") return { stdout: "proposed\n", stderr: "" };
        if (args[0] === "push") {
          if (shape === "acknowledged-late") remoteSha = "proposed";
          throw commandError("push failed");
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      };

      const acquisition = acquireOriginLock({ repoDir: "/cache", identity, exec });
      if (shape === "acknowledged-late") {
        await expect(acquisition).resolves.toMatchObject({ displaced: null });
      } else {
        await expect(acquisition).rejects.toThrow(/Could not update origin lock/);
      }
    },
  );

  it.each([
    {
      name: "acknowledged-late renewal",
      replacement: undefined,
      onSecondPush: () => ({ remoteSha: "commit-2", error: commandError("ack lost") }),
      expected: { kind: "renewed" },
    },
    {
      name: "replacement renewal",
      replacement: { ...claim({ hostname: "host-b" }), sha: "replacement" },
      onSecondPush: () => ({ remoteSha: "replacement", error: commandError("lease rejected") }),
      expected: { kind: "lost", reason: "replaced" },
    },
    {
      name: "unchanged expected sha",
      replacement: undefined,
      onSecondPush: () => ({ remoteSha: "commit-1", error: commandError("push failed") }),
      expected: { kind: "retained" },
    },
  ])("reconciles a failed $name CAS", async ({ replacement, onSecondPush, expected }) => {
    const seam = leaseExec({ onSecondPush, ...(replacement ? { replacement } : {}) });
    const acquired = await acquireOriginLock({ repoDir: "/cache", identity, exec: seam.exec });
    await expect(acquired.lock.renew()).resolves.toMatchObject(expected);
  });

  it("uses classification time for expiry after a failed renewal and unavailable reread", async () => {
    let clockMs = now.getTime();
    const seam = leaseExec({
      rereadUnavailable: true,
      onSecondPush: () => {
        clockMs = now.getTime() + ORIGIN_LOCK_LEASE_MS;
        return { remoteSha: "commit-1", error: commandError("push failed") };
      },
    });
    const acquired = await acquireOriginLock({
      repoDir: "/cache", identity, exec: seam.exec, now: () => new Date(clockMs),
    });
    await expect(acquired.lock.renew()).resolves.toMatchObject({
      kind: "lost",
      reason: "expired-unrenewable",
      detail: "origin could not be asked",
    });
  });

  it.each([
    ["acknowledged-late delete", null],
    ["replacement", "replacement"],
  ] as const)("recovers release after %s", async (_name, afterPush) => {
    const seam = leaseExec({
      onSecondPush: () => ({
        remoteSha: afterPush,
        error: commandError("delete acknowledgement lost"),
      }),
      ...(afterPush === null ? {} : { replacement: { ...claim(), sha: afterPush } }),
    });
    const acquired = await acquireOriginLock({ repoDir: "/cache", identity, exec: seam.exec });
    await expect(acquired.lock.release()).resolves.toBeUndefined();
    expect(seam.remoteSha()).toBe(afterPush);
  });

  it.each(["unchanged", "unavailable"] as const)(
    "fails release when a rejected delete reread is $shape",
    async (shape) => {
      const seam = leaseExec({
        rereadUnavailable: shape === "unavailable",
        onSecondPush: () => ({
          remoteSha: "commit-1",
          error: commandError("delete failed"),
        }),
      });
      const acquired = await acquireOriginLock({
        repoDir: "/cache", identity, exec: seam.exec,
      });
      await expect(acquired.lock.release()).rejects.toThrow(/Could not release origin lock/);
    },
  );

  it("propagates unexpected exec-seam failures unchanged", async () => {
    const bug = new Error("adapter bug");
    const exec: OriginLockExec = async () => { throw bug; };
    await expect(acquireOriginLock({ repoDir: "/cache", identity, exec }))
      .rejects.toBe(bug);
  });
});
