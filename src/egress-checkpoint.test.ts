// The egress proxy's records on the caller side (#202): `egressReport` turns a
// drain's first sightings and a teardown summary into run events, and the
// inner loop's checkpoint drains after every agent invocation and lets a dead
// proxy, not the agent, own a failure.

import { describe, expect, it, vi } from "vitest";

import { AgentError, type Sandbox } from "./agent-sandbox.js";
import {
  type EgressHandle,
  EgressProxyDiedError,
  type EgressReport,
  egressReport,
} from "./egress.js";
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
  const setup = (run: Sandbox["run"], alive = true) => {
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
      drain: vi.fn(async () => ({ firstRefusals: [refusal], refused: ["evil.test:443"] })),
      assertAlive: vi.fn(async () => {
        if (!alive) throw new EgressProxyDiedError("egress proxy p died (gone)");
      }),
    } as unknown as EgressHandle;
    const report = { refusals: vi.fn(async () => undefined), stopped: vi.fn() } as unknown as EgressReport;
    return { inner, egress, report, sandbox: withEgressCheckpoints(inner, egress, report) };
  };
  const result = { stdout: "ok", commits: [], durationMs: 1, silent: false, maxGapMs: 0, endedBy: "exit", toolCalls: 0 } as const;

  it("records the refusals an invocation's proxy first sighted", async () => {
    const { sandbox, report, egress } = setup(async () => result);
    await expect(sandbox.run({} as never)).resolves.toBe(result);
    expect(egress.drain).toHaveBeenCalledOnce();
    expect(report.refusals).toHaveBeenCalledWith([refusal]);
    expect(egress.assertAlive).not.toHaveBeenCalled();
  });

  it("keeps the agent's failure while the proxy lives, and records its refusals", async () => {
    const failure = new AgentError("exit 1");
    const { sandbox, report, egress } = setup(async () => {
      throw failure;
    });
    await expect(sandbox.run({} as never)).rejects.toBe(failure);
    expect(egress.assertAlive).toHaveBeenCalledOnce();
    expect(report.refusals).toHaveBeenCalledWith([refusal]);
  });

  it("raises a dead proxy in place of the agent's failure", async () => {
    const { sandbox } = setup(async () => {
      throw new AgentError("exit 1");
    }, false);
    await expect(sandbox.run({} as never)).rejects.toBeInstanceOf(EgressProxyDiedError);
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
