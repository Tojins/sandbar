import { describe, expect, it } from "vitest";

import {
  type ChecksOutcome,
  type ForgeCheckRun,
  type PullRequestRef,
  type PushOutcome,
  type VerifiedLandingOptions,
  type VerifiedLandingResult,
  type VerifyAdapter,
  aggregateCheckRuns,
  buildForgeRedTrace,
  jobIdFromDetailsUrl,
  latestByName,
  runVerifiedLanding,
  waitForChecks,
} from "./forge-verify.js";
import type { IssueRef, ResolveAdapter } from "./resolve-loop.js";

function run(
  over: Partial<ForgeCheckRun> & { readonly name: string },
): ForgeCheckRun {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    detailsUrl: `https://github.com/o/r/actions/runs/9/job/${over.id ?? 1}`,
    ...over,
  };
}

function issue(n: number): IssueRef {
  return { id: String(n), title: `t-${n}`, branch: `sandbar/issue-${n}-t` };
}

describe("latestByName", () => {
  it("keeps only the highest-id run per check name", () => {
    const r = latestByName([
      run({ name: "tests", id: 1, conclusion: "failure" }),
      run({ name: "tests", id: 7, conclusion: "success" }),
      run({ name: "browser", id: 2 }),
    ]);
    expect(r.map((x) => [x.name, x.id])).toEqual([
      ["tests", 7],
      ["browser", 2],
    ]);
  });
});

describe("aggregateCheckRuns", () => {
  it("is pending — not vacuously green — when the forge reports nothing yet", () => {
    expect(aggregateCheckRuns([]).kind).toBe("pending");
  });

  it("is green only when every reported check has concluded successfully", () => {
    const v = aggregateCheckRuns([
      run({ name: "tests" }),
      run({ name: "lint", id: 2, conclusion: "skipped" }),
      run({ name: "audit", id: 3, conclusion: "neutral" }),
    ]);
    expect(v).toEqual({ kind: "green", names: ["tests", "lint", "audit"] });
  });

  it("is pending while any considered check is unfinished", () => {
    const v = aggregateCheckRuns([
      run({ name: "tests" }),
      run({ name: "browser", id: 2, status: "in_progress", conclusion: null }),
    ]);
    expect(v).toEqual({ kind: "pending", waitingOn: ["browser"] });
  });

  it.each([
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "stale",
    "some_future_conclusion",
  ])("treats a '%s' conclusion as red", (conclusion) => {
    const v = aggregateCheckRuns([run({ name: "tests", conclusion })]);
    expect(v.kind).toBe("red");
  });

  it("treats a completed check with a null conclusion as red, never as green", () => {
    const v = aggregateCheckRuns([run({ name: "tests", conclusion: null })]);
    expect(v.kind).toBe("red");
  });

  it("lets a re-run supersede the earlier red run of the same name", () => {
    const v = aggregateCheckRuns([
      run({ name: "tests", id: 1, conclusion: "failure" }),
      run({ name: "tests", id: 2, conclusion: "success" }),
    ]);
    expect(v.kind).toBe("green");
  });

  it("with requiredChecks, ignores unrelated checks entirely", () => {
    const v = aggregateCheckRuns(
      [
        run({ name: "tests" }),
        run({ name: "codecov", id: 2, conclusion: "failure" }),
      ],
      ["tests"],
    );
    expect(v).toEqual({ kind: "green", names: ["tests"] });
  });

  it("with requiredChecks, stays pending until a named check appears", () => {
    const v = aggregateCheckRuns([run({ name: "tests" })], ["tests", "browser"]);
    expect(v).toEqual({ kind: "pending", waitingOn: ["browser"] });
  });
});

describe("jobIdFromDetailsUrl", () => {
  it("extracts the Actions job id", () => {
    expect(
      jobIdFromDetailsUrl("https://github.com/o/r/actions/runs/12/job/345"),
    ).toBe("345");
  });
  it("returns null for a non-Actions check", () => {
    expect(jobIdFromDetailsUrl("https://example.com/checks/7")).toBeNull();
  });
});

describe("buildForgeRedTrace", () => {
  it("summarises each failing job under its own heading", () => {
    const t = buildForgeRedTrace([
      { name: "tests", log: "phpunit: 1 failure" },
      { name: "browser", log: "playwright: timeout" },
    ]);
    expect(t).toContain("### tests");
    expect(t).toContain("phpunit: 1 failure");
    expect(t).toContain("### browser");
    expect(t).toContain("playwright: timeout");
  });

  it("degrades to a placeholder rather than an empty prompt", () => {
    expect(buildForgeRedTrace([])).toContain("no job log");
  });

  it("says so when a job produced no step output, instead of a bare heading", () => {
    const t = buildForgeRedTrace([{ name: "tests", log: "  \n " }]);
    expect(t).toContain("### tests");
    expect(t).toContain("no step output captured");
  });
});

// ---------------------------------------------------------------------------
// waitForChecks — fake clock, no real timers.
// ---------------------------------------------------------------------------

function fakeClock(stepMs: number) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms || stepMs;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("waitForChecks", () => {
  const opts = { timeoutMs: 60_000, pollIntervalMs: 1_000 };

  it("polls until the checks conclude", async () => {
    const clock = fakeClock(1_000);
    const pages: ForgeCheckRun[][] = [
      [run({ name: "tests", status: "queued", conclusion: null })],
      [run({ name: "tests", status: "in_progress", conclusion: null })],
      [run({ name: "tests" })],
    ];
    let calls = 0;
    const out = await waitForChecks("sha1", opts, {
      listCheckRuns: async () => pages[calls++] ?? [],
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out).toEqual({ kind: "green", names: ["tests"] });
    expect(calls).toBe(3);
  });

  it("returns red with the failing runs", async () => {
    const clock = fakeClock(1_000);
    const failing = run({ name: "tests", conclusion: "failure" });
    const out = await waitForChecks("sha1", opts, {
      listCheckRuns: async () => [failing],
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out).toEqual({ kind: "red", failed: [failing] });
  });

  it("times out rather than reporting an unfinished check as green", async () => {
    const clock = fakeClock(1_000);
    const out = await waitForChecks("sha1", { ...opts, timeoutMs: 5_000 }, {
      listCheckRuns: async () => [
        run({ name: "browser", status: "in_progress", conclusion: null }),
      ],
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out).toEqual({ kind: "timeout", waitingOn: ["browser"] });
  });

  it("gives up early, with a distinct outcome, when no check ever appears", async () => {
    const clock = fakeClock(1_000);
    const out = await waitForChecks(
      "sha1",
      { ...opts, timeoutMs: 600_000, pollIntervalMs: 1_000 },
      {
        listCheckRuns: async () => [],
        sleep: clock.sleep,
        now: clock.now,
        // grace well below timeoutMs — the point of the distinction
      },
    );
    expect(out.kind).toBe("no-checks");
    // Bounded by the grace window, not by the (10x longer) check timeout.
    expect(clock.now()).toBeLessThan(600_000);
  });
});

// ---------------------------------------------------------------------------
// runVerifiedLanding
// ---------------------------------------------------------------------------

type VerifyScript = {
  pushes?: PushOutcome[];
  checks?: ChecksOutcome[]; // one per round, mapped onto listCheckRuns pages
  fastForward?: PushOutcome;
  agents?: string[]; // resolve-agent stdout per attempt
  gates?: boolean[]; // local gate green? per resolve attempt
  heads?: string[]; // getHeadSha responses, in order
};

type VerifyCalls = {
  pushIntegration: string[];
  listed: string[];
  fastForwarded: string[];
  prCreated: number;
  prClosed: { number: number; comment: string }[];
  logsFetched: string[];
  agentPrompts: string[];
};

function makeVerify(script: VerifyScript): {
  verify: VerifyAdapter;
  resolve: ResolveAdapter;
  calls: VerifyCalls;
} {
  const calls: VerifyCalls = {
    pushIntegration: [],
    listed: [],
    fastForwarded: [],
    prCreated: 0,
    prClosed: [],
    logsFetched: [],
    agentPrompts: [],
  };
  let round = 0;
  let heads = 0;
  let agents = 0;
  let gates = 0;

  const outcomeToRuns = (o: ChecksOutcome | undefined): ForgeCheckRun[] => {
    if (!o) return [run({ name: "tests" })];
    if (o.kind === "green") return [run({ name: "tests" })];
    if (o.kind === "red") return [...o.failed];
    if (o.kind === "no-checks") return [];
    return [run({ name: "tests", status: "in_progress", conclusion: null })];
  };

  const verify: VerifyAdapter = {
    async pushIntegration(branch) {
      calls.pushIntegration.push(branch);
      return script.pushes?.[calls.pushIntegration.length - 1] ?? { kind: "ok" };
    },
    async listCheckRuns(sha) {
      calls.listed.push(sha);
      return outcomeToRuns(script.checks?.[round]);
    },
    async fetchFailureLog(r) {
      calls.logsFetched.push(r.name);
      return `log for ${r.name}`;
    },
    async fastForwardSource(sha) {
      calls.fastForwarded.push(sha);
      return script.fastForward ?? { kind: "ok" };
    },
    async ensurePullRequest(): Promise<PullRequestRef> {
      calls.prCreated += 1;
      return { number: 99, url: "https://github.com/o/r/pull/99" };
    },
    async closePullRequest(number, comment) {
      calls.prClosed.push({ number, comment });
    },
  };

  const resolve: ResolveAdapter = {
    async runResolveAgent(prompt) {
      calls.agentPrompts.push(prompt);
      // A resolve attempt means the current round's verdict is spent; the next
      // listCheckRuns belongs to the next round.
      round += 1;
      return { stdout: script.agents?.[agents++] ?? "<promise>COMMITTED</promise>" };
    },
    async isMergeInProgress() {
      return false;
    },
    async conflictDigest() {
      return { status: "", diff: "" };
    },
    async npmInstall() {
      return { ok: true };
    },
    async runGate() {
      const green = script.gates?.[gates++] ?? true;
      return green
        ? { ok: true }
        : {
            ok: false,
            stdout: "local gate red",
            stderr: "",
            failedStep: "test" as const,
            exitCode: 1,
          };
    },
    async getIssueBody(id) {
      return `body of #${id}`;
    },
    async getHeadSha() {
      return script.heads?.[heads++] ?? `sha-${heads}`;
    },
  };

  return { verify, resolve, calls };
}

const baseOptions: VerifiedLandingOptions = {
  integrationBranch: "sandbar/integration",
  checkTimeoutMs: 60_000,
  pollIntervalMs: 1_000,
  sourceBranch: "main",
  projectAnchor: "ANCHOR",
  mergedIssues: [issue(7), issue(9)],
  cycleIssues: [issue(7), issue(9)],
};

async function land(
  script: VerifyScript,
  over: Partial<VerifiedLandingOptions> = {},
): Promise<{ result: VerifiedLandingResult; calls: VerifyCalls }> {
  const { verify, resolve, calls } = makeVerify(script);
  const clock = fakeClock(1_000);
  const result = await runVerifiedLanding(
    { ...baseOptions, ...over },
    { verify, resolve, sleep: clock.sleep, now: clock.now },
  );
  return { result, calls };
}

describe("runVerifiedLanding", () => {
  it("green on the first round: pushes the integration ref, then fast-forwards that exact sha", async () => {
    const { result, calls } = await land({
      checks: [{ kind: "green", names: ["tests"] }],
      heads: ["sha-A"],
    });
    expect(result).toEqual({
      kind: "landed",
      sha: "sha-A",
      rounds: 1,
      pullRequest: null,
    });
    expect(calls.pushIntegration).toEqual(["sandbar/integration"]);
    expect(calls.fastForwarded).toEqual(["sha-A"]);
    // The verdict is asked for the pushed sha, never for the branch.
    expect(calls.listed).toEqual(["sha-A"]);
    expect(calls.prCreated).toBe(0);
  });

  it("does not open a pull request unless asked, and opens exactly one when asked", async () => {
    const { result, calls } = await land(
      { checks: [{ kind: "green", names: ["tests"] }], heads: ["sha-A"] },
      { openPullRequest: true },
    );
    expect(calls.prCreated).toBe(1);
    expect(result.kind === "landed" && result.pullRequest?.number).toBe(99);
  });

  it("feeds a red forge to the resolve loop and re-verifies the fixed sha", async () => {
    const failing = run({ name: "browser", conclusion: "failure" });
    const { result, calls } = await land({
      checks: [{ kind: "red", failed: [failing] }, { kind: "green", names: [] }],
      // round-1 head, the resolve loop's HEAD-advance check, round-2 head
      heads: ["sha-A", "sha-B", "sha-B"],
    });
    expect(result).toEqual({
      kind: "landed",
      sha: "sha-B",
      rounds: 2,
      pullRequest: null,
    });
    expect(calls.logsFetched).toEqual(["browser"]);
    expect(calls.pushIntegration.length).toBe(2);
    expect(calls.fastForwarded).toEqual(["sha-B"]);
    // The prompt carries the CI log, not just the check name.
    expect(calls.agentPrompts[0]).toContain("log for browser");
    expect(calls.agentPrompts[0]).toContain("browser");
    // Cross-branch context: both cycle issues reach the agent.
    expect(calls.agentPrompts[0]).toContain("body of #7");
    expect(calls.agentPrompts[0]).toContain("body of #9");
  });

  it("parks the cycle when the forge is still red after the round budget", async () => {
    const failing = run({ name: "tests", conclusion: "failure" });
    const { result, calls } = await land(
      {
        checks: [
          { kind: "red", failed: [failing] },
          { kind: "red", failed: [failing] },
        ],
        heads: ["sha-A", "sha-B", "sha-B"],
      },
      { maxRounds: 2 },
    );
    expect(result.kind).toBe("abandoned");
    expect(result.kind === "abandoned" && result.reason).toBe("checks-red");
    expect(calls.fastForwarded).toEqual([]);
  });

  it("parks the cycle when the resolve loop gives up", async () => {
    const failing = run({ name: "tests", conclusion: "failure" });
    const { result, calls } = await land({
      checks: [{ kind: "red", failed: [failing] }],
      agents: ["<promise>ABANDON</promise><reason>intents collide</reason>"],
      heads: ["sha-A"],
    });
    expect(result.kind === "abandoned" && result.reason).toBe("resolve-abandon");
    expect(result.kind === "abandoned" && result.detail).toContain(
      "intents collide",
    );
    expect(calls.fastForwarded).toEqual([]);
  });

  it("closes an open pull request when the cycle is abandoned", async () => {
    const failing = run({ name: "tests", conclusion: "failure" });
    const { calls } = await land(
      {
        checks: [{ kind: "red", failed: [failing] }],
        agents: ["<promise>ABANDON</promise><reason>nope</reason>"],
        heads: ["sha-A"],
      },
      { openPullRequest: true },
    );
    expect(calls.prClosed.map((p) => p.number)).toEqual([99]);
  });

  it("never fast-forwards on an unknown verdict (checks that never conclude)", async () => {
    const { result, calls } = await land({
      checks: [{ kind: "timeout", waitingOn: ["tests"] }],
      heads: ["sha-A"],
    });
    expect(result.kind === "abandoned" && result.reason).toBe("checks-timeout");
    expect(calls.fastForwarded).toEqual([]);
  });

  it("never fast-forwards when no check ran at all", async () => {
    const { result, calls } = await land(
      { checks: [{ kind: "no-checks" }], heads: ["sha-A"] },
      // Grace inside the check-timeout window, so "nothing ever ran" is
      // reported as itself rather than collapsing into a plain timeout.
      { noChecksGraceMs: 10_000 },
    );
    expect(result.kind === "abandoned" && result.reason).toBe("no-checks");
    expect(calls.fastForwarded).toEqual([]);
  });

  it("is fatal (not a parked cycle) when the integration push is rejected", async () => {
    const { result, calls } = await land({
      pushes: [{ kind: "rejected", reason: "stale info" }],
      heads: ["sha-A"],
    });
    expect(result.kind).toBe("fatal");
    expect(calls.listed).toEqual([]);
  });

  it("is fatal when the verified sha no longer fast-forwards the source branch", async () => {
    const { result } = await land({
      checks: [{ kind: "green", names: ["tests"] }],
      fastForward: { kind: "rejected", reason: "non-fast-forward" },
      heads: ["sha-A"],
    });
    expect(result.kind).toBe("fatal");
    expect(result.kind === "fatal" && result.detail).toContain("moved");
  });
});
