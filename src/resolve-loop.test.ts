import { describe, expect, it } from "vitest";

import type { MergerGateOutput } from "./merger.js";
import { SandbarError } from "./errors.js";
import {
  RESOLVE_MAX_ATTEMPTS,
  type IssueRef,
  type ResolveAdapter,
  type ResolveAgentRun,
  type ResolveAttemptRecord,
  type ResolveMode,
  formatConflictPaths,
  formatResolveAttempts,
  isInfraFailure,
  parseResolveSignal,
  runResolveLoop,
} from "./resolve-loop.js";

function issue(n: number): IssueRef {
  return { id: String(n), title: `t-${n}`, branch: `sandbar/issue-${n}` };
}

function gateOut(): MergerGateOutput {
  return {
    stdout: "test out",
    stderr: "test err",
    failedStep: "test",
    exitCode: 1,
    containerLogs: "\n--- container db (last 40 lines) ---\nstack log line",
  };
}

// The one-field shape every scripted run is written in; `agentRun` fills in
// the eight the adapter really answers with (#67).
type AgentResult = ResolveAgentRun;

// A scripted invocation that ran, printed and exited 0 — the shape almost every
// test in this file wants, so that only the tests ABOUT the invocation have to
// spell out an exit code or a signal.
function agentRun(over: Partial<ResolveAgentRun> = {}): ResolveAgentRun {
  const stdout = over.stdout ?? "";
  return {
    stdout,
    output: stdout,
    stderr: "",
    end: "exit",
    exitCode: 0,
    signal: null,
    durationMs: 1234,
    container: "sandbar-wdeadbeef-resolve-1-uuid",
    ...over,
  };
}
type GateResp =
  | { ok: true }
  | ({ ok: false } & MergerGateOutput);

type Script = {
  agentRuns: {
    stdout: string;
    output?: string;
    leavesConflict?: boolean;
    run?: Partial<ResolveAgentRun>;
  }[];
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
      // The `attempt` arg is ignored here; the tests that care about it assert
      // on the record the sink receives.
      const entry = script.agentRuns[aIdx++];
      if (!entry) throw new Error("agent run not scripted");
      calls.agentRuns++;
      calls.prompts.push(prompt);
      const output = entry.output ?? entry.stdout;
      const signal = parseResolveSignal(output);
      if (signal.kind === "COMMITTED") {
        merging = entry.leavesConflict ?? false;
      } else if (signal.kind === "ABANDON") {
        if (entry.leavesConflict !== undefined) merging = entry.leavesConflict;
      }
      return agentRun({ stdout: entry.stdout, output, ...entry.run });
    },
    async isMergeInProgress() {
      calls.isMergeInProgressCalls++;
      return merging;
    },
    async conflictDigest() {
      calls.conflictDigestCalls++;
      return {
        status: "UU foo.ts\nUU bar.ts",
        diff: "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>>",
        paths: ["foo.ts", "bar.ts"],
      };
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

  it("reads the promise from parsed speech rather than raw provider JSONL", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{
        stdout: JSON.stringify({ transport: "<promise>ABANDON</promise>" }),
        output: "<promise>COMMITTED</promise>",
      }],
      gates: [{ ok: true }],
    });
    const out = await runResolveLoop(issue(42), [], conflictMode, adapter, {
      projectAnchor,
    });
    expect(out).toEqual({ kind: "resolved" });
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
    expect(out).toMatchObject({
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
    // #24 D9: the stack's container logs reach the agent alongside the step
    // output. Without them a step that fails because a service is 500ing is
    // undiagnosable from the step's own text.
    expect(calls.prompts[1]).toContain("--- container db (last 40 lines) ---");
    expect(calls.prompts[1]).toContain("stack log line");
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
    expect(out).toMatchObject({
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

describe("runResolveLoop — forge-red mode (#22)", () => {
  const forgeRedMode: ResolveMode = {
    kind: "forge-red",
    initialTrace: "### browser\nplaywright: expected 1 got 0",
    failedChecks: "browser, tests",
  };

  it("first prompt carries the CI trace and names the failing checks", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: false,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      heads: ["after-fix"],
    });
    await runResolveLoop(issue(42), [], forgeRedMode, adapter, {
      projectAnchor,
      preMergeSha: "before-fix",
    });
    expect(calls.prompts[0]).toContain("playwright: expected 1 got 0");
    expect(calls.prompts[0]).toContain("browser, tests");
    // The agent must be told the local gate's green is not evidence against
    // the forge's red — otherwise "works on my machine" is the obvious move.
    expect(calls.prompts[0]).toContain("evidence against this failure");
    // No conflict digest is fetched: the tree is merged and clean.
    expect(calls.conflictDigestCalls).toBe(0);
  });

  it("a green local gate after a real commit is 'worth re-asking the forge', i.e. resolved", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: false,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      heads: ["after-fix"],
    });
    const out = await runResolveLoop(issue(42), [], forgeRedMode, adapter, {
      projectAnchor,
      preMergeSha: "before-fix",
    });
    expect(out).toEqual({ kind: "resolved" });
  });

  it("an agent that commits nothing is a silent abandon, not a re-push", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: false,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      heads: ["before-fix"],
    });
    const out = await runResolveLoop(issue(42), [], forgeRedMode, adapter, {
      projectAnchor,
      preMergeSha: "before-fix",
    });
    expect(out.kind).toBe("abandon");
    expect(out.kind === "abandon" && out.silent).toBe(true);
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

// #60 — the merge has two possible targets now, and the prompt has to name the
// one this merge is actually into. The agent reads "into X" and then reasons
// about what is on X.
describe("runResolveLoop — landing target in the prompt", () => {
  it("says the source branch when the caller says nothing", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    await runResolveLoop(issue(42), [], conflictMode, adapter, {
      projectAnchor,
    });
    expect(calls.prompts[0]).toContain("into the source branch");
  });

  it("names the chunk branch when the merge is onto one", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    await runResolveLoop(issue(42), [], conflictMode, adapter, {
      projectAnchor,
      target: "its chunk's branch `sandbar/chunk-42-c`",
    });
    expect(calls.prompts[0]).toContain("sandbar/chunk-42-c");
    expect(calls.prompts[0]).not.toContain("into the source branch");
  });

  it("names it in gate-red mode too", async () => {
    const { adapter, calls } = makeAdapter({
      agentRuns: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    await runResolveLoop(
      issue(42),
      [],
      {
        kind: "gate-red",
        initialOutput: {
          stdout: "boom",
          stderr: "",
          failedStep: "test",
          exitCode: 1,
          containerLogs: "",
        },
      },
      adapter,
      { projectAnchor, target: "its chunk's branch `sandbar/chunk-42-c`" },
    );
    expect(calls.prompts[0]).toContain("merged cleanly into its chunk's branch");
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

// ---------------------------------------------------------------------------
// #67 — what an attempt leaves behind, and what happens when nothing ran.
// ---------------------------------------------------------------------------

// A sink that records what it was handed and answers with a path, exactly as
// the cycle logger does.
function makeSink(): {
  sink: (r: ResolveAttemptRecord) => Promise<string | null>;
  records: ResolveAttemptRecord[];
} {
  const records: ResolveAttemptRecord[] = [];
  return {
    records,
    sink: async (r) => {
      records.push(r);
      return `/logs/cycle-1/resolve-${r.issueId}-attempt-${r.attempt}.log`;
    },
  };
}

describe("isInfraFailure (#67)", () => {
  it("is true for output-less exits, whatever the exit code says", () => {
    expect(isInfraFailure(agentRun({ stdout: "", exitCode: 0 }))).toBe(true);
    expect(isInfraFailure(agentRun({ stdout: "", exitCode: 1 }))).toBe(true);
    // Whitespace is not output: an agent that printed a newline said nothing.
    expect(isInfraFailure(agentRun({ stdout: "  \n " }))).toBe(true);
  });

  it("is true for a runtime that never produced a process, output or not", () => {
    expect(
      isInfraFailure(agentRun({ end: "spawn-error", detail: "ENOENT" })),
    ).toBe(true);
  });

  it("is FALSE for a timeout — it ran the whole budget in the container", () => {
    expect(
      isInfraFailure(
        agentRun({ stdout: "", end: "timeout", exitCode: null, signal: "SIGTERM" }),
      ),
    ).toBe(false);
  });

  it("is false whenever the agent actually said something", () => {
    expect(isInfraFailure(agentRun({ stdout: "thinking...", exitCode: 1 }))).toBe(
      false,
    );
  });

  it("keeps speech as evidence when an in-band provider failure follows it", () => {
    expect(
      isInfraFailure(
        agentRun({ output: "thinking...", providerFailure: "terminal fault" }),
      ),
    ).toBe(false);
  });
});

describe("runResolveLoop — an attempt that never ran (#67)", () => {
  it("throws instead of re-prompting, and does not spend the rest of the budget", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      // Four scripted runs available; only one may be spent.
      agentRuns: [
        { stdout: "", run: { exitCode: 1, stderr: "Error: image not known" } },
        { stdout: "<promise>COMMITTED</promise>" },
        { stdout: "<promise>COMMITTED</promise>" },
        { stdout: "<promise>COMMITTED</promise>" },
      ],
      gates: [{ ok: true }],
    });
    await expect(
      runResolveLoop(issue(64), [], conflictMode, adapter, { projectAnchor }),
    ).rejects.toBeInstanceOf(SandbarError);
    expect(calls.agentRuns).toBe(1);
  });

  it("names the container, how it ended, and where its output went", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [
        {
          stdout: "",
          run: {
            exitCode: 125,
            container: "sandbar-wdeadbeef-resolve-1-abc",
            stderr: "Error: cannot connect to podman socket",
          },
        },
      ],
    });
    const { sink } = makeSink();
    const err = await runResolveLoop(
      issue(64),
      [],
      conflictMode,
      adapter,
      { projectAnchor, onAttempt: sink },
    ).catch((e: unknown) => e as Error);
    expect(err.message).toContain("sandbar-wdeadbeef-resolve-1-abc");
    expect(err.message).toContain("exited with code 125");
    expect(err.message).toContain("resolve-64-attempt-1.log");
    // The three attempts it did NOT spend are the point of halting here.
    expect(err.message).toContain("remaining 3 resolve attempts");
    // stderr was piped to nobody before this issue; it is the whole diagnosis.
    expect(err.message).toContain("cannot connect to podman socket");
  });

  it("says so plainly when no sink was wired, rather than naming a file", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "" }],
    });
    const err = await runResolveLoop(issue(64), [], conflictMode, adapter, {
      projectAnchor,
    }).catch((e: unknown) => e as Error);
    expect(err.message).toContain("not captured to a file");
  });

  it("captures the attempt BEFORE it throws — the halt is what the file explains", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [{ stdout: "", run: { stderr: "boom" } }],
    });
    const { sink, records } = makeSink();
    await runResolveLoop(issue(64), [], conflictMode, adapter, {
      projectAnchor,
      onAttempt: sink,
    }).catch(() => undefined);
    expect(records).toHaveLength(1);
    expect(records[0]?.stderr).toBe("boom");
  });
});

describe("runResolveLoop — the timeout is a spent attempt (#67)", () => {
  const timedOut = {
    stdout: "",
    run: {
      end: "timeout" as const,
      exitCode: null,
      signal: "SIGTERM",
      durationMs: 600_777,
    },
  };

  it("re-prompts rather than halting, and names the timeout in the log", async () => {
    const { adapter, calls } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [timedOut, { stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    const out = await runResolveLoop(
      issue(64),
      [],
      conflictMode,
      adapter,
      { projectAnchor },
      (l) => {
        lines.push(l);
      },
    );
    expect(out).toEqual({ kind: "resolved" });
    expect(calls.agentRuns).toBe(2);
    expect(lines.some((l) => l.includes("ended=timeout after=600.8s"))).toBe(true);
  });

  it("names it in the comment's journal too", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [timedOut, timedOut, timedOut, timedOut],
    });
    const out = await runResolveLoop(issue(64), [], conflictMode, adapter, {
      projectAnchor,
    });
    if (out.kind !== "abandon") throw new Error("expected abandon");
    expect(out.attempts).toHaveLength(RESOLVE_MAX_ATTEMPTS);
    expect(formatResolveAttempts(out.attempts)).toContain(
      "10-minute per-attempt timeout",
    );
  });
});

describe("runResolveLoop — the journal an abandon carries (#67)", () => {
  it("records every attempt with its end, its sizes and its log path", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [
        { stdout: "<promise>COMMITTED</promise>", leavesConflict: true },
        { stdout: "<promise>COMMITTED</promise>", leavesConflict: true },
        { stdout: "<promise>COMMITTED</promise>", leavesConflict: true },
        { stdout: "<promise>COMMITTED</promise>", leavesConflict: true },
      ],
    });
    const { sink } = makeSink();
    const out = await runResolveLoop(issue(64), [], conflictMode, adapter, {
      projectAnchor,
      onAttempt: sink,
    });
    if (out.kind !== "abandon") throw new Error("expected abandon");
    expect(out.attempts.map((a) => a.attempt)).toEqual([1, 2, 3, 4]);
    expect(out.attempts.every((a) => a.verdict === "still-conflicted")).toBe(true);
    expect(out.attempts[0]?.logPath).toBe(
      "/logs/cycle-1/resolve-64-attempt-1.log",
    );
    expect(out.attempts[0]?.stdoutBytes).toBeGreaterThan(0);
    // The conflicted paths ride along, because the comment lists them and the
    // loop is the only thing that ever asked git for them.
    expect(out.conflictPaths).toEqual(["foo.ts", "bar.ts"]);
  });

  it("carries no conflicted paths out of a gate-red run, which never had any", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: false,
      agentRuns: [
        {
          stdout:
            "<reason>not fixable here</reason>\n<promise>ABANDON</promise>",
        },
      ],
    });
    const out = await runResolveLoop(issue(64), [], gateRedMode, adapter, {
      projectAnchor,
    });
    if (out.kind !== "abandon") throw new Error("expected abandon");
    expect(out.conflictPaths).toEqual([]);
    expect(out.attempts.map((a) => a.verdict)).toEqual(["abandon"]);
  });

  it("hands the sink the mode the attempt was answering", async () => {
    const { adapter } = makeAdapter({
      initiallyConflicted: true,
      agentRuns: [
        { stdout: "<promise>COMMITTED</promise>" },
        { stdout: "<promise>COMMITTED</promise>" },
      ],
      installs: [true, true],
      gates: [{ ok: false, ...gateOut() }, { ok: true }],
    });
    const { sink, records } = makeSink();
    await runResolveLoop(issue(64), [], conflictMode, adapter, {
      projectAnchor,
      preMergeSha: "before",
      onAttempt: sink,
    });
    expect(records.map((r) => r.mode)).toEqual(["still-conflicted", "gate-red"]);
    expect(records.map((r) => r.issueId)).toEqual(["64", "64"]);
  });
});

describe("the attempt-by-attempt prose (#67)", () => {
  it("tells a timeout apart from a container that exited in seconds", () => {
    const text = formatResolveAttempts([
      {
        attempt: 1,
        end: "timeout",
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 600_777,
        container: "c-1",
        stdoutBytes: 0,
        stderrBytes: 0,
        verdict: "still-conflicted",
        logPath: "/logs/a1.log",
      },
      {
        attempt: 2,
        end: "exit",
        exitCode: 1,
        signal: null,
        durationMs: 2_500,
        container: "c-2",
        stdoutBytes: 0,
        stderrBytes: 40,
        verdict: "still-conflicted",
        logPath: "/logs/a2.log",
      },
    ]);
    expect(text).toContain("**Attempt 1**");
    expect(text).toContain("600.8s");
    expect(text).toContain("10-minute per-attempt timeout");
    expect(text).toContain("**Attempt 2**");
    expect(text).toContain("exited with code 1 after 2.5s");
    expect(text).toContain("/logs/a2.log");
  });

  it("says outright when an attempt's output went nowhere", () => {
    const text = formatResolveAttempts([
      {
        attempt: 1,
        end: "signal",
        exitCode: null,
        signal: "SIGKILL",
        durationMs: 9_000,
        container: "c-1",
        stdoutBytes: 0,
        stderrBytes: 0,
        verdict: "still-conflicted",
        logPath: null,
      },
    ]);
    expect(text).toContain("killed by SIGKILL");
    expect(text).not.toContain("Output:");
  });

  it("renders nothing at all for an empty conflicted-path list", () => {
    // A gate-red abandon has none, and "conflicted paths: none" would read as a
    // clean merge rather than as a question that was never asked.
    expect(formatConflictPaths([])).toBe("");
    expect(formatConflictPaths(["a.ts"])).toContain("`a.ts`");
    expect(formatConflictPaths(["a.ts", "b.ts"])).toContain("(2)");
  });
});
