import { describe, expect, it, vi } from "vitest";

import {
  BUG_BODY_MAX_CHARS,
  type AttributedRange,
  type DeployRun,
  type DeployWatchAdapter,
  type DeployWatchEvent,
  type ExaminedRange,
  type Landing,
  type TickInput,
  attributeCommits,
  classifyConclusion,
  createDeployWatcher,
  decideTick,
  deployRanges,
  parseRunMarker,
  rangesDue,
  realDeployWatchAdapter,
  renderAttemptComment,
  renderBugBody,
  renderBugTitle,
  renderOriginComment,
  runMarker,
} from "./deploy-watch.js";
import type { ExecFn } from "./forge-verify.js";
import { OriginLeaseLostDuringCleanupError } from "./origin-lock.js";

const sha = (tag: string | number): string => String(tag).padEnd(40, "0");

const run = (id: number, over: Partial<DeployRun> = {}): DeployRun => ({
  id,
  headSha: sha(`a${id}`),
  status: "completed",
  conclusion: "success",
  attempt: 1,
  url: `https://github.com/o/r/actions/runs/${id}`,
  ...over,
});

const landing = (issue: number, over: Partial<Landing> = {}): Landing => ({
  issue,
  title: `Issue ${issue}`,
  sha: sha(`b${issue}`),
  committedAtMs: 1_000,
  ...over,
});

const attributed = (
  r: DeployRun,
  landings: readonly Landing[] = [landing(7), landing(8)],
): AttributedRange => ({ run: r, anchor: run(r.id - 1), landings, otherCommits: 0 });

const examined = (
  range: AttributedRange,
  over: Partial<ExaminedRange> = {},
): ExaminedRange => ({
  range,
  bug: null,
  commentedOrigins: new Set(),
  attemptCommented: false,
  ...over,
});

const tick = (over: Partial<TickInput>): TickInput => ({
  examined: [],
  pending: [],
  reportedLandings: new Set(),
  nowMs: 10_000,
  timeoutMs: 5_000,
  seeding: false,
  ...over,
});

const kinds = (input: TickInput) =>
  decideTick(input).map((a) =>
    a.kind === "comment-origin" ? `${a.kind}:${a.issue}` : a.kind === "record"
      ? `record:${a.outcome}:${a.emit ? "emit" : "quiet"}${a.filed ? ":filed" : ""}`
      : a.kind === "record-unverified"
        ? `record-unverified:${a.landing.issue}:${a.emit ? "emit" : "quiet"}`
        : a.kind,
  );

const settings = {
  workflow: "deploy.yml",
  notifyLogin: "Tojins",
  label: "deploy-red",
  timeoutMs: 5_000,
};

describe("classifyConclusion", () => {
  it.each([
    ["queued", "", "pending"],
    ["in_progress", "", "pending"],
    ["waiting", "", "pending"],
    ["completed", "success", "green"],
    ["completed", "neutral", "green"],
    ["completed", "cancelled", "ignore"],
    ["completed", "skipped", "unverified"],
    ["completed", "failure", "red"],
    ["completed", "timed_out", "red"],
    ["completed", "action_required", "red"],
    ["completed", "startup_failure", "red"],
    ["completed", "stale", "red"],
    ["completed", "", "red"],
    ["completed", "a_future_value", "red"],
  ])("%s/%j is %s", (status, conclusion, verdict) => {
    expect(classifyConclusion(status, conclusion)).toBe(verdict);
  });
});

describe("deployRanges", () => {
  const pairs = (runs: DeployRun[]) =>
    deployRanges(runs).map((r) => [r.run.id, r.anchor.id]);

  it("pairs each run with its predecessor, whatever order they are listed in", () => {
    expect(pairs([run(3), run(1), run(2)])).toEqual([[2, 1], [3, 2]]);
  });

  it("skips a cancelled run as an anchor and as a verdict", () => {
    expect(pairs([run(1), run(2, { conclusion: "cancelled" }), run(3)])).toEqual([[3, 1]]);
  });

  it("skips two cancelled runs in a row", () => {
    expect(
      pairs([
        run(1),
        run(2, { conclusion: "cancelled" }),
        run(3, { conclusion: "cancelled" }),
        run(4, { conclusion: "failure" }),
      ]),
    ).toEqual([[4, 1]]);
  });

  it("leaves the oldest run unanchored", () => {
    expect(pairs([run(1)])).toEqual([]);
    expect(pairs([run(1, { conclusion: "cancelled" }), run(2)])).toEqual([]);
  });

  it("anchors on a run still in progress", () => {
    expect(pairs([run(1), run(2, { status: "in_progress", conclusion: "" }), run(3)]))
      .toEqual([[2, 1], [3, 2]]);
  });
});

describe("rangesDue", () => {
  const ranges = deployRanges([
    run(1),
    run(2),
    run(3, { conclusion: "failure", attempt: 2 }),
    run(4, { status: "queued", conclusion: "" }),
  ]);

  it("keeps concluded ranges not handled at their current attempt", () => {
    expect(rangesDue(ranges, new Map([[2, 1], [3, 1]])).map((r) => r.run.id)).toEqual([3]);
    expect(rangesDue(ranges, new Map([[2, 1], [3, 2]]))).toEqual([]);
  });
});

describe("attributeCommits", () => {
  const c = (s: string, parents: string[], subject = `commit ${s}`) => ({
    sha: s,
    parents,
    committedAtMs: s.length,
    subject,
  });

  it("counts only the commits outside every issue merge", () => {
    // main: chunk merge C of the chunk line H (issue 1) → J (human) → K (issue 2),
    // where issue 2's branch I2 started after J.
    const commits = [
      c("C", ["X", "K"], "Merge sandbar/chunk-1-c: C"),
      c("K", ["J", "I2"], "Merge sandbar/issue-2: Two"),
      c("I2", ["J"]),
      c("J", ["H"]),
      c("H", ["X", "I1"], "Merge sandbar/issue-1: One"),
      c("I1", ["X"]),
    ];
    expect(attributeCommits(commits)).toEqual({
      landings: [
        { issue: 2, title: "Two", sha: "K", committedAtMs: 1 },
        { issue: 1, title: "One", sha: "H", committedAtMs: 1 },
      ],
      otherCommits: 1,
    });
  });

  it("keeps an issue's newest merge", () => {
    const commits = [
      c("R", ["H", "Q"], "Merge sandbar/issue-1: One again"),
      c("Q", ["H"]),
      c("H", ["X", "I1"], "Merge sandbar/issue-1: One"),
      c("I1", ["X"]),
    ];
    expect(attributeCommits(commits).landings).toEqual([
      { issue: 1, title: "One again", sha: "R", committedAtMs: 1 },
    ]);
  });

  it("finds nothing to blame in a range of human commits", () => {
    expect(attributeCommits([c("B", ["A"]), c("A", ["Z"])])).toEqual({
      landings: [],
      otherCommits: 2,
    });
  });
});

describe("decideTick", () => {
  it("files a red run's bug, then comments on each originating issue", () => {
    expect(kinds(tick({ examined: [examined(attributed(run(5, { conclusion: "failure" })))] })))
      .toEqual(["file-bug", "comment-origin:7", "comment-origin:8", "record:red:emit:filed"]);
  });

  it("does nothing more once the bug and its comments exist", () => {
    const range = attributed(run(5, { conclusion: "failure" }));
    expect(
      kinds(tick({
        examined: [examined(range, {
          bug: { issue: 90, runId: 5, filedAttempt: 1 },
          commentedOrigins: new Set([7, 8]),
        })],
      })),
    ).toEqual(["record:red:quiet"]);
  });

  it("redoes only the comment a crash left missing", () => {
    const range = attributed(run(5, { conclusion: "failure" }));
    expect(
      kinds(tick({
        examined: [examined(range, {
          bug: { issue: 90, runId: 5, filedAttempt: 1 },
          commentedOrigins: new Set([7]),
        })],
      })),
    ).toEqual(["comment-origin:8", "record:red:emit"]);
  });

  it.each([
    ["failure", "record:red:emit"],
    ["success", "record:green:emit"],
  ])("comments once on the bug for a rerun that concluded %s", (conclusion, record) => {
    const range = attributed(run(5, { conclusion, attempt: 2 }));
    const bug = { issue: 90, runId: 5, filedAttempt: 1 };
    const done = new Set([7, 8]);
    expect(kinds(tick({ examined: [examined(range, { bug, commentedOrigins: done })] })))
      .toEqual(["comment-attempt", record]);
    expect(
      kinds(tick({
        examined: [examined(range, { bug, commentedOrigins: done, attemptCommented: true })],
      })),
    ).toEqual([record.replace(":emit", conclusion === "failure" ? ":quiet" : ":emit")]);
  });

  it("files a red rerun of a run that was green, on its attempt", () => {
    const [action] = decideTick(tick({
      examined: [examined(attributed(run(5, { conclusion: "failure", attempt: 2 })))],
    }));
    expect(action).toMatchObject({ kind: "file-bug", range: { run: { attempt: 2 } } });
  });

  it("files nothing for a range with only human commits", () => {
    expect(kinds(tick({ examined: [examined(attributed(run(5, { conclusion: "failure" }), []))] })))
      .toEqual(["record:red:quiet"]);
  });

  it("takes stock while seeding: no green or unverified, but reds are still ensured", () => {
    expect(
      kinds(tick({
        seeding: true,
        examined: [
          examined(attributed(run(4))),
          examined(attributed(run(5, { conclusion: "skipped" }))),
          examined(attributed(run(6, { conclusion: "failure" }))),
        ],
        pending: [landing(9, { committedAtMs: 0 })],
      })),
    ).toEqual([
      "record:green:quiet",
      "record:unverified:quiet",
      "file-bug",
      "comment-origin:7",
      "comment-origin:8",
      "record:red:emit:filed",
      "record-unverified:9:quiet",
    ]);
  });

  it("reports an uncovered landing unverified at its deadline, once", () => {
    const at = landing(9, { committedAtMs: 5_000 });
    expect(kinds(tick({ pending: [at], nowMs: 9_999 }))).toEqual([]);
    expect(kinds(tick({ pending: [at], nowMs: 10_000 }))).toEqual(["record-unverified:9:emit"]);
    expect(kinds(tick({ pending: [at], nowMs: 20_000 }))).toEqual(["record-unverified:9:emit"]);
    expect(kinds(tick({ pending: [at], nowMs: 20_000, reportedLandings: new Set([at.sha]) })))
      .toEqual([]);
  });
});

describe("markers and renderers", () => {
  const red = run(123, { conclusion: "failure", attempt: 2 });
  const jobs = {
    failed: [{ name: "deploy", url: "https://j/1", conclusion: "failure", failedSteps: ["Health check"] }],
    logs: [{ name: "deploy", log: "health check failed" }],
  };
  const body = (range: AttributedRange = attributed(red), j = jobs) =>
    renderBugBody({ settings, range, jobs: j });

  it("round-trips the marker through every rendered text", () => {
    expect(parseRunMarker(runMarker(123, 2))).toEqual({ runId: 123, attempt: 2 });
    for (const text of [
      body(),
      renderOriginComment({ workflow: "deploy.yml", run: red, bugIssue: 90 }),
      renderAttemptComment({ workflow: "deploy.yml", run: red }),
    ]) {
      expect(parseRunMarker(text)).toEqual({ runId: 123, attempt: 2 });
    }
    expect(parseRunMarker("no marker here")).toBeNull();
  });

  it("mentions the operator in the bug body only", () => {
    expect(body()).toContain("@Tojins");
    expect(renderOriginComment({ workflow: "deploy.yml", run: red, bugIssue: 90 })).not.toContain("@");
    expect(renderAttemptComment({ workflow: "deploy.yml", run: red })).not.toContain("@");
  });

  it("names the run, the range, its landings, the failed job and its log", () => {
    const text = body({ ...attributed(red), otherCommits: 2 });
    expect(renderBugTitle("deploy.yml", red)).toBe("Deploy failed: deploy.yml run 123 on a123000");
    for (const part of [
      red.url,
      red.headSha,
      "a122000..a123000",
      "- #7 — Issue 7 (merge `b700000`)",
      "- 2 other commit(s)",
      "[deploy](https://j/1)",
      "`Health check`",
      "health check failed",
      "https://github.com/o/r/actions/runs/122 (`success`)",
      "No revert was attempted.",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("ready-for-agent");
  });

  it("stays under the body bound with a huge log or a huge landing list", () => {
    const hugeLog = { ...jobs, logs: [{ name: "deploy", log: "x".repeat(80).concat("\n").repeat(5_000) }] };
    const many = attributed(red, Array.from({ length: 2_000 }, (_, i) => landing(i, { title: "t".repeat(60) })));
    for (const text of [body(attributed(red), hugeLog), body(many)]) {
      expect(text.length).toBeLessThanOrEqual(BUG_BODY_MAX_CHARS);
      expect(parseRunMarker(text)).toEqual({ runId: 123, attempt: 2 });
    }
  });
});

describe("realDeployWatchAdapter argv", () => {
  type Call = { file: string; args: readonly string[]; timeout: number | undefined };
  const fake = (answer: (args: readonly string[]) => string) => {
    const log: (Call | "lease")[] = [];
    const exec: ExecFn = async (file, args, opts) => {
      log.push({ file, args, timeout: opts.timeout });
      return { stdout: answer(args), stderr: "" };
    };
    const adapter = realDeployWatchAdapter({
      repo: { owner: "o", name: "r" },
      repoDir: "/cache/repo.git",
      sourceBranch: "main",
      workflow: "deploy.yml",
      label: "deploy-red",
      beforeOriginWrite: async () => {
        log.push("lease");
      },
      exec,
    });
    return { adapter, log, calls: () => log.filter((c): c is Call => c !== "lease") };
  };

  const answers = (args: readonly string[]): string => {
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "run list") {
      return JSON.stringify([{ databaseId: 5, headSha: sha("a5"), status: "completed", conclusion: "failure", attempt: 1, url: "u" }]);
    }
    if (cmd === "run view" && args.includes("--json")) {
      const job = (id: number, conclusion: string) => ({
        databaseId: id,
        name: `job ${id}`,
        url: `https://j/${id}`,
        conclusion,
        steps: [{ name: "ok", conclusion: "success" }, { name: `step ${id}`, conclusion: "failure" }],
      });
      return JSON.stringify({
        jobs: [job(1, "success"), job(2, "failure"), job(3, "cancelled"), job(4, "failure"), job(5, "timed_out"), job(6, "failure")],
      });
    }
    if (cmd === "run view") return `log of ${args[args.indexOf("--job") + 1]}`;
    if (cmd === "issue list") {
      return JSON.stringify([
        { number: 90, body: `${runMarker(5, 1)}\nbody` },
        { number: 91, body: "a human's issue with the label" },
      ]);
    }
    if (cmd === "issue view") {
      return JSON.stringify({ comments: [{ body: "hi" }, { body: `x ${runMarker(5, 2)}` }] });
    }
    if (cmd === "issue create") return "https://github.com/o/r/issues/93\n";
    return "";
  };

  it("names the repository in every gh call, the cache in every git call, and bounds each", async () => {
    const { adapter, calls } = fake(answers);
    await adapter.listRuns();
    await adapter.landingsBetween(sha("a4"), sha("a5"));
    await adapter.landingsSince(sha("a4"));
    await adapter.failedJobs(5);
    await adapter.listBugs();
    await adapter.hasMarker(7, 5, null);
    await adapter.createIssue("t", "b");
    await adapter.comment(7, "c");
    for (const call of calls()) {
      expect(call.timeout).toBe(60_000);
      if (call.file === "gh") expect(call.args[call.args.indexOf("--repo") + 1]).toBe("o/r");
      else expect(call.args.slice(0, 2)).toEqual(["-C", "/cache/repo.git"]);
    }
    expect(calls().find((c) => c.args[0] === "run" && c.args[1] === "list")?.args).toEqual([
      "run", "list", "--repo", "o/r", "--workflow", "deploy.yml", "--branch", "main",
      "--event", "push", "--limit", "20", "--json", "databaseId,headSha,status,conclusion,attempt,url",
    ]);
    expect(calls().some((c) => c.args.includes(`${sha("a4")}..refs/remotes/origin/main`))).toBe(true);
  });

  it("creates the bug with both labels and never ready-for-agent, behind the write barrier", async () => {
    const { adapter, log } = fake(answers);
    expect(await adapter.createIssue("t", "b")).toBe(93);
    await adapter.comment(7, "c");
    expect(log).toEqual([
      "lease",
      {
        file: "gh",
        args: ["issue", "create", "--repo", "o/r", "--title", "t", "--body", "b",
          "--label", "ready-for-human", "--label", "deploy-red"],
        timeout: 60_000,
      },
      "lease",
      { file: "gh", args: ["issue", "comment", "7", "--repo", "o/r", "--body", "c"], timeout: 60_000 },
    ]);
  });

  it("reads bug records from the label listing's body markers", async () => {
    expect(await fake(answers).adapter.listBugs()).toEqual([{ issue: 90, runId: 5, filedAttempt: 1 }]);
  });

  it("matches a comment marker for the run, at any or one attempt", async () => {
    const { adapter } = fake(answers);
    expect(await adapter.hasMarker(7, 5, null)).toBe(true);
    expect(await adapter.hasMarker(7, 5, 2)).toBe(true);
    expect(await adapter.hasMarker(7, 5, 1)).toBe(false);
    expect(await adapter.hasMarker(7, 6, null)).toBe(false);
  });

  it("lists failed jobs with their failed steps, and fetches logs for the first three", async () => {
    const { adapter, calls } = fake(answers);
    const jobs = await adapter.failedJobs(5);
    expect(jobs.failed.map((j) => [j.name, j.failedSteps])).toEqual([
      ["job 2", ["step 2"]],
      ["job 4", ["step 4"]],
      ["job 5", ["step 5"]],
      ["job 6", ["step 6"]],
    ]);
    expect(jobs.logs).toEqual([
      { name: "job 2", log: "log of 2" },
      { name: "job 4", log: "log of 4" },
      { name: "job 5", log: "log of 5" },
    ]);
    expect(calls().filter((c) => c.args.includes("--log-failed"))).toHaveLength(3);
  });

  it("answers null for a range end the cache lacks", async () => {
    const exec: ExecFn = async (_file, args) => {
      if (args.includes("rev-parse") && args.some((a) => a.startsWith(sha("a4")))) {
        throw Object.assign(new Error("missing"), { code: 1 });
      }
      return { stdout: "", stderr: "" };
    };
    const adapter = realDeployWatchAdapter({
      repo: { owner: "o", name: "r" },
      repoDir: "/cache/repo.git",
      sourceBranch: "main",
      workflow: "deploy.yml",
      label: "deploy-red",
      beforeOriginWrite: async () => undefined,
      exec,
    });
    expect(await adapter.landingsBetween(sha("a4"), sha("a5"))).toBeNull();
    expect(await adapter.landingsBetween(sha("a3"), sha("a5"))).toEqual({ landings: [], otherCommits: 0 });
  });
});

describe("createDeployWatcher", () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  const fakeAdapter = (over: Partial<DeployWatchAdapter> = {}): DeployWatchAdapter => ({
    listRuns: vi.fn(async () => [run(1), run(2, { conclusion: "failure" })]),
    landingsBetween: vi.fn(async () => ({ landings: [landing(7), landing(8)], otherCommits: 0 })),
    landingsSince: vi.fn(async () => ({ landings: [], otherCommits: 0 })),
    failedJobs: vi.fn(async () => ({ failed: [], logs: [] })),
    listBugs: vi.fn(async () => []),
    hasMarker: vi.fn(async () => false),
    createIssue: vi.fn(async () => 90),
    comment: vi.fn(async () => undefined),
    ...over,
  });

  const watcher = (adapter: DeployWatchAdapter) => {
    const events: DeployWatchEvent[] = [];
    const onRateLimited = vi.fn(async () => undefined);
    const w = createDeployWatcher({
      adapter,
      settings,
      emit: async (e) => {
        events.push(e);
      },
      onRateLimited,
      now: () => 10_000,
    });
    // The fakes answer in microtasks, so one macrotask turn ends a tick.
    const tick = async () => {
      w.kick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { w, events, onRateLimited, tick };
  };

  it("files a red run once, comments on each origin, and records it", async () => {
    const adapter = fakeAdapter();
    const { w, events, tick } = watcher(adapter);
    await tick();
    await tick();
    await w.stop();
    expect(adapter.createIssue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapter.comment).mock.calls.map(([issue, body]) => [issue, body.includes("#90")]))
      .toEqual([[7, true], [8, true]]);
    expect(events).toEqual([{
      kind: "deploy",
      outcome: "red",
      workflow: "deploy.yml",
      runId: 2,
      attempt: 1,
      sha: run(2).headSha,
      issues: [7, 8],
      bugIssue: 90,
      filed: true,
    }]);
  });

  it("handles a run once per process, and emits green only after seeding", async () => {
    let runs = [run(1), run(2)];
    const adapter = fakeAdapter({ listRuns: vi.fn(async () => runs) });
    const { w, events, tick } = watcher(adapter);
    await tick();
    await tick();
    expect(adapter.landingsBetween).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    runs = [...runs, run(3)];
    await tick();
    await w.stop();
    expect(events).toEqual([expect.objectContaining({ kind: "deploy", outcome: "green", runId: 3 })]);
  });

  it("ignores a kick while a tick is in flight, and writes nothing after stop", async () => {
    const gate = deferred<readonly DeployRun[]>();
    const adapter = fakeAdapter({ listRuns: vi.fn(() => gate.promise) });
    const { w, events } = watcher(adapter);
    w.kick();
    w.kick();
    const stopped = w.stop();
    gate.resolve([run(1), run(2, { conclusion: "failure" })]);
    await stopped;
    w.kick();
    expect(adapter.listRuns).toHaveBeenCalledTimes(1);
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(adapter.comment).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  const ghFailure = (stderr: string) =>
    Object.assign(new Error(`Command failed: gh run list\n${stderr}`), { code: 1, stderr });

  it("hands a rate limit to onRateLimited and ends the tick", async () => {
    const adapter = fakeAdapter({
      listRuns: vi.fn(async () => {
        throw ghFailure("API rate limit exceeded for user");
      }),
    });
    const { w, events, onRateLimited, tick } = watcher(adapter);
    await tick();
    await w.stop();
    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("reports an unanswered request as a notice, and a forge answer as one complaint per message", async () => {
    let failure = ghFailure("error connecting to api.github.com");
    const adapter = fakeAdapter({
      listRuns: vi.fn(async () => {
        throw failure;
      }),
    });
    const { w, events, tick } = watcher(adapter);
    await tick();
    await tick();
    failure = ghFailure("HTTP 404: Not Found");
    await tick();
    await tick();
    await w.stop();
    expect(events.map((e) => e.kind)).toEqual(["notice", "notice", "complaint"]);
    expect(events[2]).toMatchObject({ severity: "warning", message: "Deploy watch: HTTP 404: Not Found" });
  });

  it("abandons the tick silently when the lease is lost to cleanup", async () => {
    const adapter = fakeAdapter({
      createIssue: vi.fn(async () => {
        throw new OriginLeaseLostDuringCleanupError("lost");
      }),
    });
    const { w, events, tick } = watcher(adapter);
    await tick();
    await w.stop();
    expect(adapter.comment).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("lets anything else propagate", async () => {
    const adapter = fakeAdapter({
      listRuns: vi.fn(async () => {
        throw new TypeError("a bug");
      }),
    });
    const { w } = watcher(adapter);
    w.kick();
    await expect(w.stop()).rejects.toThrow("a bug");
  });
});
