// The egress proxy's records on the caller side (#202): `egressReport` turns a
// drain's first sightings and a teardown summary into run events, and the
// inner loop checkpoints the sandbox's proxy after every agent invocation and
// lets a dead proxy, not the agent, own a failure and the agent's output
// carry its secret (#257).

import { describe, expect, it, vi } from "vitest";

import { AgentError, type Sandbox } from "./agent-sandbox.js";
import { EgressProxyDiedError, type OwnerProxy, egressReport } from "./egress.js";
import type { EgressRefusal } from "./egress-policy.js";
import type { EventInput } from "./events.js";
import { withEgressCheckpoints } from "./inner-loop.js";

const refusal: EgressRefusal = { host: "evil.test", port: 443, via: "tls", enforced: true };

describe("egressReport", () => {
  it("records each first sighting, then the teardown's own and the summary", async () => {
    const events: EventInput[] = [];
    const report = egressReport((event) => {
      events.push(event);
    }, { stack: "gate", issue: 7, title: "Seven" });
    await report.refusals([refusal]);
    await report.stopped({
      mode: "report",
      allowed: { "github.com:443": 2 },
      refused: { "evil.test:443": 1, "late.test": 1 },
      upstreamErrors: {},
      firstRefusals: [{ host: "late.test", port: null, via: "dns", enforced: false }],
      durationMs: 9,
      peakMemoryBytes: 1024,
    });
    expect(events).toEqual([
      { kind: "egress-refused", stack: "gate", issue: 7, title: "Seven", ...refusal },
      { kind: "egress-refused", stack: "gate", issue: 7, title: "Seven",
        host: "late.test", port: null, via: "dns", enforced: false },
      { kind: "egress", stack: "gate", issue: 7, title: "Seven", mode: "report",
        allowed: { "github.com:443": 2 }, refused: { "evil.test:443": 1, "late.test": 1 },
        upstreamErrors: {}, durationMs: 9, peakMemoryBytes: 1024 },
    ]);
  });
});

describe("withEgressCheckpoints", () => {
  const setup = (run: Sandbox["run"], alive = true, connect: OwnerProxy["connect"] = null) => {
    const inner = {
      branch: "b",
      worktreePath: "/w",
      containerName: "c",
      run: vi.fn(run),
      syncBranchToCache: vi.fn(async () => undefined),
      preserveWorktree: vi.fn(),
      deferWorktreeReclaim: vi.fn(),
      close: vi.fn(async () => ({})),
    } satisfies Sandbox;
    const egress = {
      dnsArgs: [],
      connect,
      checkpoint: vi.fn(async () => ["evil.test:443"]),
      assertAlive: vi.fn(async () => {
        if (!alive) throw new EgressProxyDiedError("egress proxy p died (gone)");
      }),
      stop: vi.fn(async () => undefined),
    } satisfies OwnerProxy;
    return { inner, egress, sandbox: withEgressCheckpoints(inner, egress) };
  };
  const result = { stdout: "ok", commits: [], durationMs: 1, silent: false, maxGapMs: 0, endedBy: "exit", toolCalls: 0 } as const;

  it("checkpoints the proxy after an invocation", async () => {
    const { sandbox, egress } = setup(async () => result);
    await expect(sandbox.run({} as never)).resolves.toEqual(result);
    expect(egress.checkpoint).toHaveBeenCalledOnce();
    expect(egress.assertAlive).not.toHaveBeenCalled();
  });

  it("keeps the agent's failure while the proxy lives, and checkpoints it", async () => {
    const failure = new AgentError("exit 1");
    const { sandbox, egress } = setup(async () => {
      throw failure;
    });
    await expect(sandbox.run({} as never)).rejects.toBe(failure);
    expect(egress.assertAlive).toHaveBeenCalledOnce();
    expect(egress.checkpoint).toHaveBeenCalledOnce();
  });

  it("raises a dead proxy in place of the agent's failure", async () => {
    const { sandbox } = setup(async () => {
      throw new AgentError("exit 1");
    }, false);
    await expect(sandbox.run({} as never)).rejects.toBeInstanceOf(EgressProxyDiedError);
  });

  it("masks the proxy's secret in the agent's output and in its failure", async () => {
    const connect = { secret: "s3cr3t", env: {} };
    const leaked = { ...result, stdout: "found s3cr3t in history" };
    const { sandbox } = setup(async () => leaked, true, connect);
    await expect(sandbox.run({} as never)).resolves.toEqual({ ...leaked, stdout: "found <secret> in history" });
    const failing = setup(async () => {
      throw new AgentError("exit 1: s3cr3t");
    }, true, connect);
    await expect(failing.sandbox.run({} as never)).rejects.toThrow(/^exit 1: <secret>$/);
  });

  it("leaves every other sandbox member the sandbox's own", async () => {
    const { sandbox, inner } = setup(async () => result);
    expect(sandbox.containerName).toBe("c");
    await sandbox.close();
    sandbox.deferWorktreeReclaim();
    expect(inner.close).toHaveBeenCalledOnce();
    expect(inner.deferWorktreeReclaim).toHaveBeenCalledOnce();
  });
});
