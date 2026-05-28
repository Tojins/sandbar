import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runStampFromDate, startRunLogger } from "./logs.js";

async function makeBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sandbar-logs-"));
}

describe("runStampFromDate", () => {
  it("replaces colons and dots so the stamp is filesystem-safe", () => {
    const stamp = runStampFromDate(new Date("2026-05-05T21:15:32.101Z"));
    expect(stamp).toBe("2026-05-05T21-15-32-101Z");
    expect(stamp.includes(":")).toBe(false);
    expect(stamp.includes(".")).toBe(false);
  });
});

describe("startRunLogger", () => {
  it("creates run-<stamp>/ with an orchestrator.log run-start marker", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({
      baseDir: base,
      now: new Date("2026-05-05T21:15:32.101Z"),
    });

    expect(logger.runDir).toBe(join(base, "run-2026-05-05T21-15-32-101Z"));
    const stamp = (await stat(logger.runDir)).isDirectory();
    expect(stamp).toBe(true);

    const orch = await readFile(
      join(logger.runDir, "orchestrator.log"),
      "utf8",
    );
    expect(orch).toMatch(/run-start/);
  });

  it("appendOrchestrator timestamps and appends each line", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    await logger.appendOrchestrator("plan: 3 unblocked");
    await logger.appendOrchestrator("cycle 1 started");

    const orch = await readFile(
      join(logger.runDir, "orchestrator.log"),
      "utf8",
    );
    const lines = orch.trim().split("\n");
    expect(lines.length).toBe(3); // run-start + 2 appends
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*Z\] plan: 3 unblocked$/);
    expect(lines[2]).toMatch(/cycle 1 started$/);
  });

  it("cycle().writePlan writes verbatim JSON to cycle-<n>/plan.json", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const plan = [
      { id: "45", title: "finalize", branch: "sandcastle/issue-45-finalize" },
      { id: "47", title: "logs", branch: "sandcastle/issue-47-logs" },
    ];
    await logger.cycle(1).writePlan(plan);

    const path = join(logger.runDir, "cycle-1", "plan.json");
    const body = await readFile(path, "utf8");
    expect(JSON.parse(body)).toEqual(plan);
    expect(body).toContain("\n");
  });

  it("cycle().appendMerger appends timestamped lines to merger.log", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const c = logger.cycle(2);
    await c.appendMerger("merge sandcastle/issue-42-foo");
    await c.appendMerger("gate green: 42");

    const body = await readFile(
      join(logger.runDir, "cycle-2", "merger.log"),
      "utf8",
    );
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/merge sandcastle\/issue-42-foo$/);
    expect(lines[1]).toMatch(/gate green: 42$/);
  });

  it("cycle().writeAttempt writes attempt-<m>.log under issue-<id>/", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const c = logger.cycle(3);
    await c.writeAttempt("47", 2, "implementer stdout");
    await c.writeAttemptReviewer("47", 2, "reviewer stdout");

    const dir = join(logger.runDir, "cycle-3", "issue-47");
    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual(["attempt-2-reviewer.log", "attempt-2.log"]);
    expect(await readFile(join(dir, "attempt-2.log"), "utf8")).toBe(
      "implementer stdout",
    );
    expect(await readFile(join(dir, "attempt-2-reviewer.log"), "utf8")).toBe(
      "reviewer stdout",
    );
  });

  it("cycle(n) returns the same logger across calls", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    expect(logger.cycle(1)).toBe(logger.cycle(1));
    expect(logger.cycle(1)).not.toBe(logger.cycle(2));
  });

  it("finalize() writes a run-end marker to orchestrator.log", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    await logger.finalize("normal-exit");

    const orch = await readFile(
      join(logger.runDir, "orchestrator.log"),
      "utf8",
    );
    expect(orch).toMatch(/run-end \(normal-exit\)/);
  });
});
