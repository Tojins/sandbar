import { describe, expect, it } from "vitest";

import {
  ORIGIN_LOCK_LEASE_MS,
  ORIGIN_LOCK_REF,
  OriginLockHeldError,
  acquireOriginLock,
  decideAcquire,
  decideRelease,
  decideRenew,
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

  it("fails closed on malformed lease commits", () => {
    expect(() => parseOriginLockLease("not json")).toThrow(/invalid lease commit/);
    expect(() => parseOriginLockLease(JSON.stringify({ ...identity })))
      .toThrow(/incomplete or invalid lease/);
  });
});

type ExecCall = {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
};

describe("origin lock git argv (#139)", () => {
  it("uses explicit CAS argv for acquire, renew and release", async () => {
    const calls: ExecCall[] = [];
    let remoteSha: string | null = null;
    let nextCommit = 0;
    let clockMs = now.getTime();
    const exec: OriginLockExec = async (file, args, options) => {
      calls.push({ file, args: [...args], cwd: options.cwd });
      if (args[0] === "ls-remote") {
        if (remoteSha === null) {
          throw Object.assign(new Error("no ref"), { code: 2 });
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
  });

  it("classifies a failed absent-CAS only after observing the winner", async () => {
    const winner = claim({ hostname: "host-b" });
    let lookup = 0;
    const exec: OriginLockExec = async (_file, args) => {
      if (args[0] === "ls-remote") {
        lookup += 1;
        if (lookup === 1) throw Object.assign(new Error("absent"), { code: 2 });
        return { stdout: `${winner.sha}\t${ORIGIN_LOCK_REF}\n`, stderr: "" };
      }
      if (args[0] === "fetch") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${winner.sha}\n`, stderr: "" };
      if (args[0] === "show") {
        return { stdout: JSON.stringify(winner.lease), stderr: "" };
      }
      if (args[0] === "hash-object") return { stdout: "tree\n", stderr: "" };
      if (args[0] === "commit-tree") return { stdout: "ours\n", stderr: "" };
      if (args[0] === "push") throw new Error("push failed");
      throw new Error("unexpected command");
    };

    await expect(acquireOriginLock({ repoDir: "/cache", identity, exec }))
      .rejects.toBeInstanceOf(OriginLockHeldError);
  });
});
