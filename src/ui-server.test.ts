import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

  it("refuses a port already owned by another workdir", async () => {
    const firstTree = await runTree(false);
    const secondTree = await runTree(false);
    const first = await startUiServer({
      logsDir: firstTree.logsDir,
      liveRunDir: firstTree.runDir,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const port = Number(new URL(first.url).port);
      await expect(startUiServer({
        logsDir: secondTree.logsDir,
        liveRunDir: secondTree.runDir,
        host: "127.0.0.1",
        port,
      })).rejects.toThrow(`Sandbar UI port ${port} is already in use`);
    } finally {
      await first.close();
    }
  });
});
