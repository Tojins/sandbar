import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVENT_SCHEMA_VERSION } from "./events.js";
import { readUiState, startUiServer } from "./ui-server.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runTree(withPid: boolean): Promise<{ logsDir: string; runDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "sandbar-ui-"));
  roots.push(root);
  const logsDir = join(root, "logs");
  const runDir = join(logsDir, "run-2026-09-07T10-00-00-000Z");
  const workdir = join(root, "state");
  await mkdir(runDir, { recursive: true });
  await mkdir(workdir, { recursive: true });
  if (withPid) await writeFile(join(workdir, "run.pid"), String(process.pid));
  await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify({
    kind: "run-start",
    schemaVersion: EVENT_SCHEMA_VERSION,
    driver: "sandbar test",
    configPath: null,
    workdir,
    maxParallelIssues: 3,
    pid: process.pid,
    seq: 1,
    ts: "2026-09-07T10:00:00.000Z",
  })}\n`);
  return { logsDir, runDir };
}

// The whole #69 identity line, as `formatDriverIdentity` spells it.
const DRIVER_LINE =
  "Driver: sandbar 0.42.5 · built from /opt/driver @abc123 clean" +
  " · config /opt/installation/sandbar.config.mjs @def456 dirty";

// The row the screenshot in #156 blamed: a parked issue whose reason is one
// unbroken line of reviewer prose. A nowrap cell this long is what stretched
// the page column — and with the wrap in place it is what has to be clamped
// and reachable on hover instead.
const PARKED_WHY =
  "parked · NEEDS-HUMAN-REVIEW · the reviewer wrote to the managed clone" +
  " during a read-only pass, so the issue is held for human inspection rather" +
  " than retried: the clone is preserved at" +
  " .sandbar/worktrees/sandbar-issue-249-long-reason with its branch published" +
  " and an off-branch HEAD pinned in the cache, and the gate-1 trace from the" +
  " attempt before it is filed beside that attempt log; push a fix on the" +
  " branch and re-apply ready-for-agent to resume, or delete the branch on" +
  " origin to abandon what the attempt accumulated there · this run";

describe("run UI server", () => {
  it("renders, polls repeatedly, and retains the last state after a network failure", async () => {
    const html = await readFile(join(process.cwd(), "ui/index.html"), "utf8");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const app = { innerHTML: "" };
    let interval: (() => Promise<void>) | undefined;
    const state = {
      now: "2026-09-07T10:29:00Z",
      run: { startedAt: "2026-09-04T21:35:00Z", status: "live", driver: DRIVER_LINE,
        slots: { used: 1, max: 2 }, lastRecompute: { n: 2, trigger: "slot freed", at: "2026-09-07T09:30:00Z" },
        exit: null, complaints: [] },
      pool: [{ issue: 2, title: "Pool title", phase: "implementer",
        phaseSince: "2026-09-07T10:21:00Z", attempt: 2,
        spans: [
          { kind: "impl", from: "2026-09-07T09:31:00Z", to: "2026-09-07T09:32:00Z", label: "a1" },
          { kind: "impl", from: "2026-09-07T10:21:00Z", to: null, label: "a2" },
        ] }],
      waiting: [{ issue: 3, title: "Waiting title", why: PARKED_WHY, parked: true }],
      landing: [{ pullRequest: 305, branch: "sandbar/chunk-177", title: "Migrations",
        members: [177], requestedAt: "2026-09-07T09:25:00Z",
        statusSince: "2026-09-07T10:27:00Z", status: "landing", step: "gate-2",
        reason: "landing together with #156 → its chunk, PR #306" }],
      finished: [{ issue: 1, title: "Finished title", outcome: "HARD-ERROR",
        reason: "provider cause\n(codex exited with code 1)", attempts: 1,
        rounds: 1, ms: 60_000, landed: "main", at: "2026-09-07T09:40:00Z" }],
      landedChunks: [{ pullRequest: 304, title: "Landed chunk", members: [299],
        target: "main", ms: 60_000, at: "2026-09-07T09:45:00Z" }],
      eventCount: 1,
      events: [{ at: "2026-09-07T09:50:00Z", issue: 2, text: "attempt started", tone: "" }],
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => state })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        ...state, run: { ...state.run, driver: "sandbar updated" },
      }) })
      .mockRejectedValueOnce(new TypeError("network down"));
    runInNewContext(script!, {
      document: { getElementById: () => app }, fetch,
      setInterval: (callback: () => Promise<void>, ms: number) => {
        expect(ms).toBe(2_000); interval = callback; return 1;
      },
      Date, Intl, Math, String, Error, TypeError,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.innerHTML).toContain("<details id=\"events\"><summary>Events");
    expect(app.innerHTML).toContain("Pool title");
    expect(app.innerHTML).toContain("Waiting title");
    expect(app.innerHTML).toContain("Landing · 1 requested");
    expect(app.innerHTML).toContain(">gate-2 2m</b> · landing together with #156 → its chunk, PR #306 · requested 1h04 ago");
    expect(app.innerHTML).toContain("PR #304");
    expect(app.innerHTML).toContain("LANDED → main · #299");
    expect(app.innerHTML.indexOf("Waiting</h2>")).toBeLessThan(
      app.innerHTML.indexOf("Landing · 1 requested"),
    );
    expect(app.innerHTML.indexOf("Landing · 1 requested")).toBeLessThan(
      app.innerHTML.indexOf("Finished recently"),
    );
    expect(app.innerHTML.indexOf("PR #304")).toBeLessThan(
      app.innerHTML.indexOf("#1</span>"),
    );
    // This run has been live for 60h54, but the timeline begins at the first
    // pool span. Ten-minute ticks stay readable and the eight-minute current
    // span occupies useful width instead of being crushed against `now`.
    const axis = app.innerHTML.match(/<div class="axis">([\s\S]*?)<\/div>/)?.[1];
    expect(axis?.match(/<span/g)).toHaveLength(7);
    expect(axis).toContain(">09:40</span>");
    expect(axis).toContain(">10:30</span>");
    expect(app.innerHTML).toContain(
      'class="bar impl  running" style="left:79.37%;width:12.70%" title="a2"',
    );
    // One long line, and nothing about it may widen the page: the parked
    // reason is clamped in its column and carried whole on the hover.
    expect(PARKED_WHY).toMatch(/^[^\n]{500,}$/);
    expect(app.innerHTML).toContain(
      `<span class="why clamp bad" title="${PARKED_WHY}">${PARKED_WHY}</span>`,
    );
    // Titles ellipsize, so the whole title is the hover's too.
    expect(app.innerHTML).toContain(
      `<span class="ellip" title="Finished title">Finished title</span>`,
    );
    // Only the first line is rendered; the rest of the cause is the title's.
    expect(app.innerHTML).toContain(">HARD-ERROR · provider cause</span>");
    expect(app.innerHTML).toContain(
      `title="provider cause\n(codex exited with code 1)"`,
    );
    // The header is the driver's name and version, with the identity line
    // (#69) reachable on it, and the slots belong to the pool's heading.
    expect(app.innerHTML).toContain(
      `<span class="name" title="${DRIVER_LINE}">sandbar 0.42.5</span>`,
    );
    expect(app.innerHTML).toContain("In the pool · 1/2 slots");
    expect(app.innerHTML.match(/slots/g)).toHaveLength(1);
    expect(app.innerHTML).toContain("attempt started");
    // A feed the reader opened stays open across the next poll's re-render.
    (app as { open?: boolean }).open = true;
    await interval?.();
    expect(app.innerHTML).toContain("sandbar updated");
    expect(app.innerHTML).toContain("<details id=\"events\" open><summary>Events");
    await interval?.();
    expect(app.innerHTML).toContain("No run is serving; last state below");
    expect(app.innerHTML).toContain("sandbar updated");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(1, "state.json", { cache: "no-store" });
  });

  it("widens timeline tick spacing at the two- and eight-hour thresholds", async () => {
    const html = await readFile(join(process.cwd(), "ui/index.html"), "utf8");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const baseState = {
      run: { startedAt: "2026-09-01T00:00:00Z", status: "live", driver: "sandbar test",
        slots: { used: 1, max: 1 }, lastRecompute: { n: 1, trigger: "startup", at: "2026-09-07T00:00:00Z" },
        exit: null, complaints: [] },
      pool: [{ issue: 1, title: "Pool title", phase: "implementer",
        phaseSince: "2026-09-07T00:00:00Z", attempt: 1,
        spans: [{ kind: "impl", from: "2026-09-07T00:00:00Z", to: null, label: "a1" }] }],
      waiting: [], finished: [], eventCount: 0, events: [],
    };
    const cases = [
      { now: "2026-09-07T01:54:00Z", labels: [
        "00:00", "00:10", "00:20", "00:30", "00:40", "00:50",
        "01:00", "01:10", "01:20", "01:30", "01:40", "01:50",
      ] },
      { now: "2026-09-07T01:55:00Z", labels: [
        "00:00", "00:30", "01:00", "01:30",
      ] },
      { now: "2026-09-07T07:54:00Z", labels: [
        "00:00", "00:30", "01:00", "01:30", "02:00", "02:30", "03:00", "03:30",
        "04:00", "04:30", "05:00", "05:30", "06:00", "06:30", "07:00", "07:30",
      ] },
      { now: "2026-09-07T07:55:00Z", labels: [
        "00:00", "02:00", "04:00", "06:00",
      ] },
    ];

    for (const testCase of cases) {
      const app = { innerHTML: "" };
      const state = { ...baseState, now: testCase.now };
      runInNewContext(script!, {
        document: { getElementById: () => app },
        fetch: async () => ({ ok: true, status: 200, json: async () => state }),
        setInterval: () => 1,
        Date, Intl, Math, String, Error, TypeError,
      });
      await new Promise((resolve) => setImmediate(resolve));
      const axis = app.innerHTML.match(/<div class="axis">([\s\S]*?)<\/div>/)?.[1] ?? "";
      const labels = [...axis.matchAll(/<span style="left:[^"]+">([^<]+)<\/span>/g)]
        .map((match) => match[1]);
      expect(labels, testCase.now).toEqual(testCase.labels);
    }
  });

  it("keeps the timeline finite before an admitted issue has a span", async () => {
    const html = await readFile(join(process.cwd(), "ui/index.html"), "utf8");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const app = { innerHTML: "" };
    const state = {
      now: "2026-09-07T10:29:00Z",
      run: { startedAt: "2026-09-04T21:35:00Z", status: "live", driver: "sandbar test",
        slots: { used: 1, max: 1 }, lastRecompute: { n: 1, trigger: "startup", at: "2026-09-07T10:29:00Z" },
        exit: null, complaints: [] },
      pool: [{ issue: 1, title: "Pool title", phase: "setup",
        phaseSince: "2026-09-07T10:29:00Z", attempt: 1, spans: [] }],
      waiting: [], finished: [], eventCount: 0, events: [],
    };
    runInNewContext(script!, {
      document: { getElementById: () => app },
      fetch: async () => ({ ok: true, status: 200, json: async () => state }),
      setInterval: () => 1,
      Date, Intl, Math, String, Error, TypeError,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.innerHTML).not.toContain("NaN%");
    expect(app.innerHTML).toContain('<span class="nowlab" style="left:0.00%">now</span>');
    expect(app.innerHTML).toContain('<span class="nowline" style="left:0.00%"></span>');
  });

  it("renders a failed state request, with or without a last state", async () => {
    const html = await readFile(join(process.cwd(), "ui/index.html"), "utf8");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    const app = { innerHTML: "" };
    let interval: (() => Promise<void>) | undefined;
    const state = {
      now: "2026-09-07T10:00:00Z",
      run: { startedAt: "2026-09-07T09:00:00Z", status: "live", driver: "sandbar test",
        slots: { used: 0, max: 2 }, lastRecompute: null, exit: null, complaints: [] },
      pool: [], waiting: [], finished: [], eventCount: 0, events: [],
    };
    const failure = { ok: false, status: 500, text: async () => "Invalid event JSON at line 7" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => state })
      .mockResolvedValueOnce(failure);
    runInNewContext(script!, {
      document: { getElementById: () => app }, fetch,
      setInterval: (callback: () => Promise<void>) => { interval = callback; return 1; },
      Date, Intl, Math, String, Error, TypeError,
    });
    await new Promise((resolve) => setImmediate(resolve));
    // No state yet: the failure is the whole page, not a blank one.
    expect(app.innerHTML).toContain("State request failed (500): Invalid event JSON at line 7");
    expect(app.innerHTML).not.toContain("sandbar test");
    await interval?.();
    expect(app.innerHTML).toContain("sandbar test");
    expect(app.innerHTML).not.toContain("State request failed");
    await interval?.();
    expect(app.innerHTML).toContain("sandbar test");
    expect(app.innerHTML).toContain("State request failed (500): Invalid event JSON at line 7");
  });

  // The drain's user-visible half (#146): a pool that admits nothing has to say
  // why for as long as it is draining, and stop saying it once it has exited.
  it("keeps a pending restart on the header until the run exits", async () => {
    const html = await readFile(join(process.cwd(), "ui/index.html"), "utf8");
    expect(html).toContain(".pill.restart{");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    const app = { innerHTML: "" };
    let interval: (() => Promise<void>) | undefined;
    const run = {
      startedAt: "2026-09-07T09:00:00Z", status: "live", driver: "sandbar test",
      slots: { used: 1, max: 2 }, lastRecompute: null, exit: null,
      restart: { detail: "abc1234", at: "2026-09-07T09:30:00Z" }, complaints: [],
    };
    const state = {
      now: "2026-09-07T10:00:00Z", run,
      pool: [], waiting: [], finished: [], eventCount: 0, events: [],
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => state })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        ...state,
        run: {
          ...run, status: "ended",
          exit: { tag: "restart", reason: "drained and exiting" },
        },
      }) });
    runInNewContext(script!, {
      document: { getElementById: () => app }, fetch,
      setInterval: (callback: () => Promise<void>) => { interval = callback; return 1; },
      Date, Intl, Math, String, Error, TypeError,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.innerHTML).toContain(
      '<span class="pill restart">restart pending · draining · abc1234</span>',
    );

    // The reducer retains the request after the exit (#146); the header must not.
    await interval?.();
    expect(app.innerHTML).toContain('<span class="pill ended">ended · restart</span>');
    expect(app.innerHTML).not.toContain("restart pending");
  });

  it("uses both run.pid and process liveness to classify standalone runs", async () => {
    const live = await runTree(true);
    await mkdir(join(live.logsDir, "run-2026-09-06T10-00-00-000Z"));
    expect((await readUiState(live.logsDir)).run.status).toBe("live");

    await rm(join(live.runDir, "../../state/run.pid"));
    expect((await readUiState(live.logsDir)).run.status).toBe("crashed");
  });

  it("uses the explicitly hosted run even when another directory sorts newer", async () => {
    const live = await runTree(false);
    const future = join(live.logsDir, "run-2099-01-01T00-00-00-000Z");
    await mkdir(future);
    await writeFile(join(future, "events.jsonl"), `${JSON.stringify({
      kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "future",
      configPath: null, workdir: "/future", maxParallelIssues: 1, pid: 999_999,
      seq: 1, ts: "2099-01-01T00:00:00.000Z",
    })}\n`);
    expect((await readUiState(live.logsDir, { liveRunDir: live.runDir })).run.driver)
      .toBe("sandbar test");
  });

  it("skips an unreadable historical record", async () => {
    const live = await runTree(false);
    const corrupt = join(live.logsDir, "run-2026-09-06T10-00-00-000Z");
    await mkdir(corrupt);
    await writeFile(join(corrupt, "events.jsonl"), "not json\n");

    await expect(readUiState(live.logsDir, { liveRunDir: live.runDir }))
      .resolves.toMatchObject({ run: { driver: "sandbar test" } });
  });

  it("loads historical chunk landings and keeps the newest record per PR", async () => {
    const live = await runTree(false);
    const currentPath = join(live.runDir, "events.jsonl");
    const current = await readFile(currentPath, "utf8");
    await writeFile(currentPath, current + `${JSON.stringify({
      kind: "landed", outcome: "chunk-on-source", branch: "sandbar/chunk-305-new",
      target: "main", pullRequest: 305, title: "New PR 305", members: [305],
      reason: null, durationMs: 30_000, seq: 2, ts: "2026-09-07T10:05:00.000Z",
    })}\n`);

    const older = join(live.logsDir, "run-2026-09-06T10-00-00-000Z");
    await mkdir(older);
    await writeFile(join(older, "events.jsonl"), [
      {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar old",
        configPath: null, workdir: "/old", maxParallelIssues: 1, pid: 999_999,
        seq: 1, ts: "2026-09-06T10:00:00.000Z",
      },
      {
        kind: "landed", outcome: "chunk-on-source", branch: "sandbar/chunk-304-old",
        target: "main", pullRequest: 304, title: "PR 304", members: [299],
        reason: null, durationMs: 60_000, seq: 2, ts: "2026-09-06T10:04:00.000Z",
      },
      {
        kind: "landed", outcome: "chunk-on-source", branch: "sandbar/chunk-305-old",
        target: "main", pullRequest: 305, title: "Old PR 305", members: [300],
        reason: null, durationMs: 90_000, seq: 3, ts: "2026-09-06T10:03:00.000Z",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const state = await readUiState(live.logsDir, { liveRunDir: live.runDir });
    expect(state.landedChunks).toEqual([
      {
        pullRequest: 305, title: "New PR 305", members: [305], target: "main",
        ms: 30_000, at: "2026-09-07T10:05:00.000Z",
      },
      {
        pullRequest: 304, title: "PR 304", members: [299], target: "main",
        ms: 60_000, at: "2026-09-06T10:04:00.000Z",
      },
    ]);
  });

  it("serves the page and reduced state from the same event file", async () => {
    const tree = await runTree(false);
    const server = await startUiServer({
      logsDir: tree.logsDir,
      liveRunDir: tree.runDir,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Sandbar Pool");

      const response = await fetch(new URL("state.json", server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        run: { status: "live", driver: "sandbar test" },
      });
    } finally {
      await server.close();
    }
  });

  it("returns a request error without terminating the server and reports each new failure once", async () => {
    const tree = await runTree(false);
    const eventsPath = join(tree.runDir, "events.jsonl");
    const valid = await readFile(eventsPath, "utf8");
    const reported: string[] = [];
    const server = await startUiServer({
      logsDir: tree.logsDir,
      liveRunDir: tree.runDir,
      host: "127.0.0.1",
      port: 0,
      onFailure: async (err) => { reported.push((err as Error).message); },
    });
    try {
      await writeFile(eventsPath, "not json\n");
      const failed = await fetch(new URL("state.json", server.url));
      expect(failed.status).toBe(500);
      expect(await failed.text()).toMatch(/Invalid event JSON/);
      // The page polls every two seconds; the host hears a failure once.
      expect((await fetch(new URL("state.json", server.url))).status).toBe(500);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatch(/Invalid event JSON/);

      await writeFile(eventsPath, valid);
      const recovered = await fetch(new URL("state.json", server.url));
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        run: { driver: "sandbar test" },
      });

      // A recurrence after recovery is a new failure.
      await writeFile(eventsPath, "not json\n");
      expect((await fetch(new URL("state.json", server.url))).status).toBe(500);
      expect(reported).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("contains a rejecting reporter on a post-listen server error", async () => {
    const tree = await runTree(false);
    let rawServer: Server | undefined;
    const onFailure = vi.fn(async () => {
      throw new Error("event filesystem unavailable");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const server = await startUiServer({
      logsDir: tree.logsDir,
      liveRunDir: tree.runDir,
      host: "127.0.0.1",
      port: 0,
      onFailure,
      serverFactory: (listener) => {
        rawServer = createHttpServer(listener);
        return rawServer;
      },
    });
    try {
      expect(() => rawServer?.emit("error", new Error("post-listen fault")))
        .not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "post-listen fault" }),
      );
      expect(unhandled).not.toHaveBeenCalled();

      const response = await fetch(new URL("state.json", server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        run: { driver: "sandbar test" },
      });
    } finally {
      process.off("unhandledRejection", unhandled);
      await server.close();
    }
  });

  it("gives invocation-neutral guidance when a standalone host's port is occupied", async () => {
    const firstTree = await runTree(false);
    const secondTree = await runTree(false);
    const first = await startUiServer({
      logsDir: firstTree.logsDir,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const port = Number(new URL(first.url).port);
      await expect(startUiServer({
        logsDir: secondTree.logsDir,
        host: "127.0.0.1",
        port,
      })).rejects.toThrow(
        `Sandbar UI port ${port} is already in use on 127.0.0.1. ` +
          "Choose a different port.",
      );
    } finally {
      await first.close();
    }
  });
});
