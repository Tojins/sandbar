import { describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import {
  type CheckRunListing,
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
  latestPerCheck,
  runVerifiedLanding,
  verifiedLandingOptionsFrom,
  waitForChecks,
} from "./forge-verify.js";
import type { IssueRef, ResolveAdapter } from "./resolve-loop.js";

function run(
  over: Partial<ForgeCheckRun> & { readonly name: string },
): ForgeCheckRun {
  return {
    id: 1,
    suiteId: 1,
    status: "completed",
    conclusion: "success",
    detailsUrl: `https://github.com/o/r/actions/runs/9/job/${over.id ?? 1}`,
    ...over,
  };
}

// Every listing the fakes hand back is a COMPLETE one unless a test is
// specifically about truncation.
function listing(runs: readonly ForgeCheckRun[]): CheckRunListing {
  return { runs, complete: true };
}

function issue(n: number): IssueRef {
  return { id: String(n), title: `t-${n}`, branch: `sandbar/issue-${n}-t` };
}

describe("latestPerCheck", () => {
  it("keeps only the highest-id run per check name within one suite", () => {
    const r = latestPerCheck([
      run({ name: "tests", id: 1, conclusion: "failure" }),
      run({ name: "tests", id: 7, conclusion: "success" }),
      run({ name: "browser", id: 2 }),
    ]);
    expect(r.map((x) => [x.name, x.id])).toEqual([
      ["tests", 7],
      ["browser", 2],
    ]);
  });

  it("does NOT let one suite's run supersede another suite's run of the same name", () => {
    // The `on: [push, pull_request]` shape: two suites, same job name, same
    // sha. Collapsing on name alone would let the newer success erase the
    // older failure and land a red commit.
    const r = latestPerCheck([
      run({ name: "tests", id: 10, suiteId: 100, conclusion: "failure" }),
      run({ name: "tests", id: 20, suiteId: 200, conclusion: "success" }),
    ]);
    expect(r).toHaveLength(2);
    expect(aggregateCheckRuns(r, ["tests"]).kind).toBe("red");
  });

  it("is insensitive to array order when suites differ", () => {
    const a = run({ name: "t", id: 10, suiteId: 1, conclusion: "failure" });
    const b = run({ name: "t", id: 20, suiteId: 2, conclusion: "success" });
    expect(aggregateCheckRuns([a, b], ["t"]).kind).toBe("red");
    expect(aggregateCheckRuns([b, a], ["t"]).kind).toBe("red");
  });
});

describe("aggregateCheckRuns", () => {
  it("is pending — not vacuously green — when the forge reports nothing yet", () => {
    expect(aggregateCheckRuns([]).kind).toBe("pending");
  });

  it("is green only when every reported check has concluded successfully", () => {
    const v = aggregateCheckRuns([
      run({ name: "tests" }),
      run({ name: "audit", id: 3, conclusion: "neutral" }),
    ]);
    expect(v).toEqual({ kind: "green", names: ["tests", "audit"] });
  });

  it("treats a 'skipped' conclusion as NOT passing", () => {
    // A job gated by `if:` or a paths filter concludes skipped having run
    // nothing. Branch protection counts that as satisfied; verified mode must
    // not, because "the test job never actually ran" is what it exists to
    // catch.
    const v = aggregateCheckRuns([run({ name: "tests", conclusion: "skipped" })]);
    expect(v.kind).toBe("red");
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

  it("with requiredChecks, still goes red on a failure OUTSIDE the list", () => {
    // requiredChecks says what must be waited for, not which reds may be
    // ignored — landing on a sha the forge displays as failing is exactly the
    // outcome this module refuses.
    const v = aggregateCheckRuns(
      [
        run({ name: "tests" }),
        run({ name: "codecov", id: 2, conclusion: "failure" }),
      ],
      ["tests"],
    );
    expect(v.kind).toBe("red");
  });

  it("with requiredChecks, does not wait for unrelated checks that are still running", () => {
    const v = aggregateCheckRuns(
      [
        run({ name: "tests" }),
        run({ name: "codecov", id: 2, status: "in_progress", conclusion: null }),
      ],
      ["tests"],
    );
    expect(v).toEqual({ kind: "green", names: ["tests"] });
  });

  it("with requiredChecks, stays pending until a named check appears", () => {
    const v = aggregateCheckRuns([run({ name: "tests" })], ["tests", "browser"]);
    expect(v).toEqual({ kind: "pending", waitingOn: ["browser"] });
  });

  it("with requiredChecks, requires EVERY suite reporting that name to pass", () => {
    const v = aggregateCheckRuns(
      [
        run({ name: "tests", id: 1, suiteId: 1, conclusion: "success" }),
        run({ name: "tests", id: 2, suiteId: 2, conclusion: "failure" }),
      ],
      ["tests"],
    );
    expect(v.kind).toBe("red");
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

describe("verifiedLandingOptionsFrom", () => {
  it("carries every knob from the resolved config to the landing", () => {
    const o = verifiedLandingOptionsFrom(
      {
        kind: "verified",
        integrationBranch: "sandbar/integration",
        requiredChecks: ["tests"],
        checkTimeoutMs: 1234,
        pollIntervalMs: 56,
        noChecksGraceMs: 78,
        openPullRequest: true,
      },
      "main",
    );
    expect(o).toEqual({
      integrationBranch: "sandbar/integration",
      requiredChecks: ["tests"],
      checkTimeoutMs: 1234,
      pollIntervalMs: 56,
      noChecksGraceMs: 78,
      openPullRequest: true,
      sourceBranch: "main",
    });
  });

  it("refuses to build a landing that would push to its own source branch", () => {
    // The catastrophic wiring slip: force-pushing the UNVERIFIED merge result
    // onto the branch verified mode exists to protect.
    expect(() =>
      verifiedLandingOptionsFrom(
        {
          kind: "verified",
          integrationBranch: "main",
          requiredChecks: ["tests"],
          checkTimeoutMs: 1,
          pollIntervalMs: 1,
          noChecksGraceMs: 1,
          openPullRequest: false,
        },
        "main",
      ),
    ).toThrow(SandbarError);
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

  it("polls until the checks conclude, then confirms the verdict is stable", async () => {
    const clock = fakeClock(1_000);
    const pages: ForgeCheckRun[][] = [
      [run({ name: "tests", status: "queued", conclusion: null })],
      [run({ name: "tests", status: "in_progress", conclusion: null })],
      [run({ name: "tests" })],
      [run({ name: "tests" })],
    ];
    let calls = 0;
    const out = await waitForChecks("sha1", opts, {
      listCheckRuns: async () => listing(pages[calls++] ?? []),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out).toEqual({ kind: "green", names: ["tests"] });
    // 3 to reach green + 1 to confirm nothing new appeared.
    expect(calls).toBe(4);
  });

  it("does not accept a green snapshot that is still growing", async () => {
    // The `workflow_run` shape: `e2e` is dispatched when `tests` concludes, so
    // it does not exist at the poll where `tests` first reads green. Without a
    // settle window this lands a red sha.
    const clock = fakeClock(1_000);
    const pages: ForgeCheckRun[][] = [
      [run({ name: "tests" })],
      [run({ name: "tests" }), run({ name: "e2e", id: 2, conclusion: "failure" })],
    ];
    let calls = 0;
    const out = await waitForChecks("sha1", opts, {
      listCheckRuns: async () => listing(pages[Math.min(calls++, 1)] ?? []),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.kind).toBe("red");
  });

  it("never reports green from an incomplete listing", async () => {
    // Truncated page read: everything visible passed, but the runs we could
    // not see are exactly the ones that might be red.
    const clock = fakeClock(1_000);
    const out = await waitForChecks(
      "sha1",
      { ...opts, timeoutMs: 5_000 },
      {
        listCheckRuns: async () => ({
          runs: [run({ name: "tests" })],
          complete: false,
        }),
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect(out.kind).toBe("timeout");
  });

  it("returns red with the failing runs", async () => {
    const clock = fakeClock(1_000);
    const failing = run({ name: "tests", conclusion: "failure" });
    const out = await waitForChecks("sha1", opts, {
      listCheckRuns: async () => listing([failing]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out).toEqual({ kind: "red", failed: [failing] });
  });

  it("times out rather than reporting an unfinished check as green", async () => {
    const clock = fakeClock(1_000);
    const out = await waitForChecks("sha1", { ...opts, timeoutMs: 5_000 }, {
      listCheckRuns: async () =>
        listing([run({ name: "browser", status: "in_progress", conclusion: null })]),
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
        listCheckRuns: async () => listing([]),
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    expect(out.kind).toBe("no-checks");
    // Bounded by the grace window, not by the (10x longer) check timeout.
    expect(clock.now()).toBeLessThan(600_000);
  });

  it("rides out a transient failure to reach the forge", async () => {
    const clock = fakeClock(1_000);
    let calls = 0;
    const out = await waitForChecks("sha1", opts, {
      listCheckRuns: async () => {
        calls++;
        if (calls <= 2) throw new Error("HTTP 502");
        return listing([run({ name: "tests" })]);
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.kind).toBe("green");
  });

  it("throws rather than reading an unreachable forge as a verdict", async () => {
    const clock = fakeClock(1_000);
    await expect(
      waitForChecks("sha1", opts, {
        listCheckRuns: async () => {
          throw new Error("HTTP 502");
        },
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow("502");
  });
});

// ---------------------------------------------------------------------------
// runVerifiedLanding
// ---------------------------------------------------------------------------

type VerifyScript = {
  pushes?: PushOutcome[];
  checks?: ChecksOutcome[]; // one per round, mapped onto listCheckRuns pages
  fastForward?: PushOutcome[];
  sync?: { ok: boolean; reason: string }[];
  agents?: string[]; // resolve-agent stdout per attempt
  gates?: boolean[]; // local gate green? per resolve attempt
  heads?: string[]; // getHeadSha responses, in order
};

type VerifyCalls = {
  pushIntegration: string[];
  listed: string[];
  fastForwarded: string[];
  synced: number;
  prCreated: number;
  prTitles: string[];
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
    synced: 0,
    prCreated: 0,
    prTitles: [],
    prClosed: [],
    logsFetched: [],
    agentPrompts: [],
  };
  let round = 0;
  let heads = 0;
  let agents = 0;
  let gates = 0;

  // An UNSCRIPTED round is pending, never green. A permissive default here
  // would mean any future round a test forgot to script gets silently verified
  // — in the one module whose whole claim is that unknown is not green.
  const outcomeToRuns = (o: ChecksOutcome | undefined): ForgeCheckRun[] => {
    if (!o) return [run({ name: "tests", status: "queued", conclusion: null })];
    if (o.kind === "green") return [run({ name: "tests" })];
    // A red round still satisfies the required floor (`tests`, in its own
    // suite) — so these tests exercise the real shape: a check the config named
    // is green and something else on the sha is failing, which must still sink
    // the cycle.
    if (o.kind === "red")
      return [...o.failed, run({ name: "tests", id: 9999, suiteId: 999 })];
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
      return listing(outcomeToRuns(script.checks?.[round]));
    },
    async fetchFailureLog(r) {
      calls.logsFetched.push(r.name);
      return `log for ${r.name}`;
    },
    async fastForwardSource(sha) {
      calls.fastForwarded.push(sha);
      return script.fastForward?.[calls.fastForwarded.length - 1] ?? { kind: "ok" };
    },
    async syncWithSource() {
      const r = script.sync?.[calls.synced] ?? { ok: true, reason: "" };
      calls.synced += 1;
      // A successful re-merge starts a new round against a new result.
      if (r.ok) round += 1;
      return r;
    },
    async ensurePullRequest({ title }): Promise<PullRequestRef> {
      calls.prCreated += 1;
      calls.prTitles.push(title);
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
  requiredChecks: ["tests"],
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
    expect(result).toMatchObject({
      kind: "landed",
      sha: "sha-A",
      rounds: 1,
      pullRequest: null,
    });
    expect(calls.pushIntegration).toEqual(["sandbar/integration"]);
    expect(calls.fastForwarded).toEqual(["sha-A"]);
    // The verdict is asked for the pushed sha, never for the branch, on every
    // poll including the settle confirmation.
    expect(new Set(calls.listed)).toEqual(new Set(["sha-A"]));
    expect(calls.prCreated).toBe(0);
  });

  it("does not open a pull request unless asked, and opens exactly one when asked", async () => {
    const { result, calls } = await land(
      { checks: [{ kind: "green", names: ["tests"] }], heads: ["sha-A"] },
      { openPullRequest: true },
    );
    expect(calls.prCreated).toBe(1);
    expect(calls.prTitles[0]).toContain("2 issue(s) into main");
    expect(result.kind === "landed" && result.pullRequest?.number).toBe(99);
  });

  it("feeds a red forge to the resolve loop and re-verifies the fixed sha", async () => {
    const failing = run({ name: "browser", conclusion: "failure" });
    const { result, calls } = await land({
      checks: [{ kind: "red", failed: [failing] }, { kind: "green", names: [] }],
      // round-1 head, the resolve loop's HEAD-advance check, round-2 head
      heads: ["sha-A", "sha-B", "sha-B"],
    });
    expect(result).toMatchObject({
      kind: "landed",
      sha: "sha-B",
      rounds: 2,
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

  it("caps how many failing jobs' logs it fetches, and says how many it left out", async () => {
    const failed = Array.from({ length: 8 }, (_, i) =>
      run({ name: `job-${i}`, id: i + 1, conclusion: "failure" }),
    );
    const { calls } = await land({
      checks: [{ kind: "red", failed }],
      heads: ["sha-A", "sha-B", "sha-B"],
    });
    expect(calls.logsFetched).toHaveLength(5);
    expect(calls.agentPrompts[0]).toContain("3 further failing check(s)");
    expect(calls.agentPrompts[0]).toContain("job-7");
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

  it("reports the sha the checks hang off, and that agent commits are about to be discarded", async () => {
    const failing = run({ name: "tests", conclusion: "failure" });
    const { result } = await land(
      {
        checks: [
          { kind: "red", failed: [failing] },
          { kind: "red", failed: [failing] },
        ],
        heads: ["sha-A", "sha-B", "sha-B"],
      },
      { maxRounds: 2 },
    );
    expect(result.kind === "abandoned" && result.lastSha).toBe("sha-B");
    expect(result.kind === "abandoned" && result.resolveCommits).toBe(true);
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

  it("closes an open pull request on a fatal too, rather than leaving it to be reused", async () => {
    const { calls } = await land(
      {
        checks: [{ kind: "green", names: ["tests"] }],
        fastForward: [{ kind: "rejected", reason: "non-fast-forward" }],
        sync: [{ ok: false, reason: "conflict" }],
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

  it("is FATAL, not a parked cycle, when the forge builds nothing for the ref", async () => {
    // Systemic, not this cycle's fault: parking would convert the whole
    // backlog to `agent-stuck` one cycle at a time for a misconfigured
    // trigger nobody was told about.
    const { result, calls } = await land(
      { checks: [{ kind: "no-checks" }], heads: ["sha-A"] },
      { noChecksGraceMs: 10_000 },
    );
    expect(result.kind).toBe("fatal");
    expect(result.kind === "fatal" && result.detail).toContain("triggers");
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

  it("re-merges and RE-VERIFIES when the source branch moves under a verified sha", async () => {
    // Routine with a multi-minute CI wait. The composed result changed, so the
    // old green does not carry over — it has to be earned again.
    const { result, calls } = await land({
      checks: [
        { kind: "green", names: ["tests"] },
        { kind: "green", names: ["tests"] },
      ],
      fastForward: [{ kind: "rejected", reason: "non-fast-forward" }, { kind: "ok" }],
      heads: ["sha-A", "sha-B"],
    });
    expect(result).toMatchObject({ kind: "landed", sha: "sha-B", rounds: 2 });
    expect(calls.synced).toBe(1);
    expect(calls.pushIntegration).toHaveLength(2);
    // The rejected sha was never landed; only the re-verified one.
    expect(calls.fastForwarded).toEqual(["sha-A", "sha-B"]);
  });

  it("parks rather than force-landing when the re-merge itself fails", async () => {
    const { result, calls } = await land({
      checks: [{ kind: "green", names: ["tests"] }],
      fastForward: [{ kind: "rejected", reason: "non-fast-forward" }],
      sync: [{ ok: false, reason: "CONFLICT in src/a.ts" }],
      heads: ["sha-A"],
    });
    expect(result.kind === "abandoned" && result.reason).toBe("source-moved");
    expect(result.kind === "abandoned" && result.detail).toContain("CONFLICT");
    expect(calls.fastForwarded).toEqual(["sha-A"]);
  });

  it("parks when the source keeps moving and the rounds run out", async () => {
    const { result } = await land(
      {
        checks: [
          { kind: "green", names: ["tests"] },
          { kind: "green", names: ["tests"] },
        ],
        fastForward: [
          { kind: "rejected", reason: "non-fast-forward" },
          { kind: "rejected", reason: "non-fast-forward" },
        ],
        heads: ["sha-A", "sha-B"],
      },
      { maxRounds: 2 },
    );
    expect(result.kind === "abandoned" && result.reason).toBe("source-moved");
  });
});
