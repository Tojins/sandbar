import { describe, expect, it } from "vitest";

import type { MergerGateOutput } from "./merger.js";
import {
  RESOLVE_MAX_ATTEMPTS,
  type IssueRef,
  type ResolveAdapter,
  type ResolveMode,
  parseResolveSignal,
  runResolveLoop,
} from "./resolve-loop.js";

function issue(n: number): IssueRef {
  return { id: String(n), title: `t-${n}`, branch: `sandbar/issue-${n}` };
}

function gateOut(): MergerGateOutput {
  return { stdout: "test out", stderr: "test err", failedStep: "test", exitCode: 1 };
}

type AgentResult = { stdout: string };
type GateResp =
  | { ok: true }
  | ({ ok: false } & MergerGateOutput);

type Script = {
  agentRuns: { stdout: string; leavesConflict?: boolean }[];
  initiallyConflicted: boolean;
  installs?: boolean[];
  gates?: GateResp[];
  bodies?: Record<string, string>;
  heads?: string[];
};

type Calls = {
  agentRuns: number;
  prompts: string[];
  isMergeInProgressCalls: number;
  conflictDigestCalls: number;
  installCalls: number;
  gateCalls: number;
  bodyFetches: string[];
  headShaCalls: number;
};

function makeAdapter(script: Script): { adapter: ResolveAdapter; calls: Calls } {
  const calls: Calls = {
    agentRuns: 0,
    prompts: [],
    isMergeInProgressCalls: 0,
    conflictDigestCalls: 0,
    installCalls: 0,
    gateCalls: 0,
    bodyFetches: [],
    headShaCalls: 0,
  };
  let aIdx = 0;
  let iIdx = 0;
  let gIdx = 0;
  let hIdx = 0;
  let merging = script.initiallyConflicted;

  const adapter: ResolveAdapter = {
    async runResolveAgent(prompt: string): Promise<AgentResult> {
      const entry = script.agentRuns[aIdx++];
      if (!entry) throw new Error("agent run not scripted");
      calls.agentRuns++;
      calls.prompts.push(prompt);
      const signal = parseResolveSignal(entry.stdout);
      if (signal.kind === "COMMITTED") {
        merging = entry.leavesConflict ?? false;
      } else if (signal.kind === "ABANDON") {
        if (entry.leavesConflict !== undefined) merging = entry.leavesConflict;
      }
      return { stdout: entry.stdout };
    },
    async isMergeInProgress() {
      calls.isMergeInProgressCalls++;
      return merging;
    },
    async conflictDigest() {
      calls.conflictDigestCalls++;
      return { status: "UU foo.ts\nUU bar.ts", diff: "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>>" };
    },
    async npmInstall() {
      const r = script.installs?.[iIdx++] ?? true;
      calls.installCalls++;
      return { ok: r };
    },
    async runGate() {
      const r = script.gates?.[gIdx++];
      if (r === undefined) throw new Error("gate not scripted (call " + calls.gateCalls + ")");
      calls.gateCalls++;
      return r;
    },
    async getIssueBody(id) {
      calls.bodyFetches.push(id);
      return script.bodies?.[id] ?? `body-of-${id}`;
    },
    async getHeadSha() {
      const idx = hIdx++;
      calls.headShaCalls++;
      return script.heads?.[idx] ?? `head-${idx}`;
    },
  };
  return { adapter, calls };
}

const projectAnchor = "# Project anchor (test)\n";
const conflictMode: ResolveMode = { kind: "conflict" };
const gateRedMode: ResolveMode = { kind: "gate-red", initialOutput: gateOut() };

describe("parseResolveSignal", () => {
  it("returns COMMITTED for a clean COMMITTED token", () => {
    expect(parseResolveSignal("done\n<promise>COMMITTED</promise>")).toEqual({
      kind: "COMMITTED",
    });
  });
  it("returns ABANDON with the reason from <reason>", () => {
    expect(
      parseResolveSignal(
        "<reason>this branch should lose to #44</reason>\n<promise>ABANDON</promise>",
      ),
    ).toEqual({ kind: "ABANDON", reason: "this branch should lose to #44" });
  });
  it("returns ABANDON with placeholder when no reason given", () => {
    expect(parseResolveSignal("<promise>ABANDON</promise>")).toEqual({
      kind: "ABANDON",
      reason: "(no reason given)",
    });
  });
  it("last-wins for multiple promise tokens", () => {
    expect(
      parseResolveSignal(
        "<promise>COMMITTED</promise>\nlater\n<promise>ABANDON</promise>",
      ),
    ).toEqual({ kind: "ABANDON", reason: "(no reason given)" });
  });
  it("NO-SIGNAL when no promise tag", () => {
    expect(parseResolveSignal("just thinking")).toEqual({ kind: "NO-SIGNAL" });
  });
  it("NO-SIGNAL for unknown token", () => {
    expect(parseResolveSignal("<promise>COMPLETE</promise>")).toEqual({
      kind: "NO-SIGNAL",
    });
  });
});

describe("runResolveLoop — conflict mode", () => {
  it("agent resolves and gate green: returns resolved in 1 attempt", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({ kind: "resolved" });
    expect(calls.agentRuns).toBe(1);
    expect(calls.installCalls).toBe(1);
    expect(calls.gateCalls).toBe(1);
  });

  it("agent ABANDON in conflict state: returns abandon with mergeInProgress=true", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [
        {
          stdout:
            "<reason>#42 supersedes #40; let #40 lose</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
      ],
    });
    const out = await runResolveLoop(
      issue(42),
      [issue(40)],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({
      kind: "abandon",
      reason: "#42 supersedes #40; let #40 lose",
      mergeInProgress: true,
    });
  });

  it("agent says COMMITTED but MERGE_HEAD still present: re-prompts, then succeeds", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [
        { stdout: "<promise>COMMITTED</promise>", leavesConflict: true },
        { stdout: "<promise>COMMITTED</promise>" },
      ],
      gates: [{ ok: true }],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({ kind: "resolved" });
    expect(calls.agentRuns).toBe(2);
    expect(calls.installCalls).toBe(1);
    expect(calls.gateCalls).toBe(1);
    expect(calls.prompts[0]).toContain("git status");
    expect(calls.prompts[1]).toContain("git status");
  });

  it("agent resolves but gate red, then fixes on attempt 2", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [
        { stdout: "<promise>COMMITTED</promise>" },
        { stdout: "<promise>COMMITTED</promise>" },
      ],
      gates: [{ ok: false, ...gateOut() }, { ok: true }],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({ kind: "resolved" });
    expect(calls.agentRuns).toBe(2);
    expect(calls.gateCalls).toBe(2);
    expect(calls.prompts[1]).toContain("Gate output");
  });

  it("gate green but HEAD didn't advance: returns silent abandon", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      heads: ["pre-sha"],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor, preMergeSha: "pre-sha" },
    );
    expect(out.kind).toBe("abandon");
    if (out.kind === "abandon") {
      expect(out.silent).toBe(true);
      expect(out.mergeInProgress).toBe(false);
      expect(out.reason).toContain("Silent no-op");
    }
    expect(calls.headShaCalls).toBe(1);
  });

  it("preMergeSha omitted: skips the HEAD-advance invariant (backward compat)", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({ kind: "resolved" });
    expect(calls.headShaCalls).toBe(0);
  });

  it("preMergeSha differs from current HEAD: returns resolved", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      heads: ["post-sha"],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor, preMergeSha: "pre-sha" },
    );
    expect(out).toEqual({ kind: "resolved" });
  });

  it("attempts exhausted after repeated gate-red: returns abandon", async () => {
    const exhaustedRuns = Array.from({ length: RESOLVE_MAX_ATTEMPTS }, () => ({
      stdout: "<promise>COMMITTED</promise>",
    }));
    const exhaustedGates: GateResp[] = Array.from(
      { length: RESOLVE_MAX_ATTEMPTS },
      () => ({ ok: false as const, ...gateOut() }),
    );
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: exhaustedRuns,
      gates: exhaustedGates,
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(out.kind).toBe("abandon");
    if (out.kind === "abandon") {
      expect(out.reason).toContain(`Exhausted ${RESOLVE_MAX_ATTEMPTS}`);
      expect(out.mergeInProgress).toBe(false);
    }
  });

  it("install fail after resolve: feeds install-failed trace forward, retries", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [
        { stdout: "<promise>COMMITTED</promise>" },
        { stdout: "<promise>COMMITTED</promise>" },
      ],
      installs: [false, true],
      gates: [{ ok: true }],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({ kind: "resolved" });
    expect(calls.installCalls).toBe(2);
    expect(calls.gateCalls).toBe(1);
    expect(calls.prompts[1]).toContain("npm install");
  });
});

describe("runResolveLoop — gate-red mode", () => {
  it("agent commits fix and gate green: resolved", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: false,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const out = await runResolveLoop(
      issue(42),
      [],
      gateRedMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({ kind: "resolved" });
    expect(calls.agentRuns).toBe(1);
    expect(calls.conflictDigestCalls).toBe(0);
  });

  it("agent ABANDON: returns abandon with mergeInProgress=false", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: false,
      agentRuns: [
        {
          stdout:
            "<reason>tests collide with #44; revert this one</reason>\n<promise>ABANDON</promise>",
        },
      ],
    });
    const out = await runResolveLoop(
      issue(42),
      [issue(44)],
      gateRedMode,
      adapter,
      { projectAnchor },
    );
    expect(out).toEqual({
      kind: "abandon",
      reason: "tests collide with #44; revert this one",
      mergeInProgress: false,
    });
  });

  it("first prompt includes the initial gate trace from the entry mode", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: false,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    await runResolveLoop(issue(42), [], gateRedMode, adapter, { projectAnchor });
    expect(calls.prompts[0]).toContain("Gate output");
    expect(calls.prompts[0]).toContain("test out");
  });
});

describe("runResolveLoop — multi-issue context", () => {
  it("fetches and embeds each related issue's body; skips self", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      bodies: {
        "42": "this branch body",
        "40": "earlier issue body",
        "44": "later issue body",
      },
    });
    await runResolveLoop(
      issue(42),
      [issue(40), issue(42), issue(44)],
      conflictMode,
      adapter,
      { projectAnchor },
    );
    expect(calls.bodyFetches).toEqual(["42", "40", "44"]);
    expect(calls.prompts[0]).toContain("this branch body");
    expect(calls.prompts[0]).toContain("earlier issue body");
    expect(calls.prompts[0]).toContain("later issue body");
    expect(calls.prompts[0]).toContain("Related issue #40");
    expect(calls.prompts[0]).toContain("Related issue #44");
  });

  it("with no related issues, the related-issues section is omitted", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    await runResolveLoop(issue(42), [], conflictMode, adapter, {
      projectAnchor,
    });
    expect(calls.prompts[0]).not.toContain("Related issues in this run");
  });
});

describe("runResolveLoop — logging", () => {
  it("emits a log line per attempt and per outcome", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    await runResolveLoop(
      issue(42),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
      (line) => {
        lines.push(line);
      },
    );
    expect(lines.some((l) => l.startsWith("resolve-attempt 1/"))).toBe(true);
    expect(lines.some((l) => l.includes("gate green"))).toBe(true);
  });
});
