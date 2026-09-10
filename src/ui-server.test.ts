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

describe("run UI server", () => {
  it("renders, polls repeatedly, and retains the last state after a network failure", async () => {
    const html = await readFile(join(process.cwd(), "ui/index.html"), "utf8");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const app = { innerHTML: "" };
    let interval: (() => Promise<void>) | undefined;
    const state = {
      now: "2026-09-07T10:00:00Z",
      run: { startedAt: "2026-09-07T09:00:00Z", status: "live", driver: "sandbar test",
        slots: { used: 1, max: 2 }, lastRecompute: { n: 2, trigger: "slot freed", at: "2026-09-07T09:30:00Z" },
        exit: null, complaints: [] },
      pool: [{ issue: 2, title: "Pool title", phase: "implementer",
        phaseSince: "2026-09-07T09:50:00Z", attempt: 1,
        spans: [{ kind: "impl", from: "2026-09-07T09:50:00Z", to: null, label: "a1" }] }],
      waiting: [{ issue: 3, title: "Waiting title", why: "blocked by #2" }],
      finished: [{ issue: 1, title: "Finished title", outcome: "HARD-ERROR",
        reason: "provider cause\n(codex exited with code 1)", attempts: 1,
        rounds: 1, ms: 60_000, landed: "main", at: "2026-09-07T09:40:00Z" }],
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
    expect(app.innerHTML).toContain("Finished title");
    expect(app.innerHTML).toContain("HARD-ERROR · provider cause");
    expect(app.innerHTML).not.toContain("codex exited with code 1");
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
