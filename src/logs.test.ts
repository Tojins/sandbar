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

  it("writePlan appends explicit triggers in recompute order", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const plan = [
      { id: "45", title: "finalize", branch: "sandbar/issue-45-finalize" },
      { id: "47", title: "logs", branch: "sandbar/issue-47-logs" },
    ];
    await logger.writePlan("launch", plan);
    await logger.writePlan("slot-freed", [{ id: "49" }]);
    await logger.writePlan("landing-finished", []);

    const path = join(logger.runDir, "plans.jsonl");
    const body = await readFile(path, "utf8");
    expect(body.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { trigger: "launch", plan },
      { trigger: "slot-freed", plan: [{ id: "49" }] },
      { trigger: "landing-finished", plan: [] },
    ]);
    expect(body).toContain("\n");
  });

  it("landing().appendMerger appends timestamped lines to merger.log", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const c = logger.landing(2);
    await c.appendMerger("merge sandbar/issue-42-foo");
    await c.appendMerger("gate green: 42");

    const body = await readFile(
      join(logger.runDir, "landing-2", "merger.log"),
      "utf8",
    );
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/merge sandbar\/issue-42-foo$/);
    expect(lines[1]).toMatch(/gate green: 42$/);
  });

  it("issue().writeAttempt writes attempt-<m>.log under issue-<id>/", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const c = await logger.issue("47");
    await c.writeAttempt("47", 2, "implementer stdout");
    await c.writeAttemptReviewer("47", 2, "reviewer stdout");

    const dir = join(logger.runDir, "issue-47");
    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual(["attempt-2-reviewer.log", "attempt-2.log"]);
    expect(await readFile(join(dir, "attempt-2.log"), "utf8")).toBe(
      "implementer stdout",
    );
    expect(await readFile(join(dir, "attempt-2-reviewer.log"), "utf8")).toBe(
      "reviewer stdout",
    );
  });

  // #67 — the file that exists so a resolve attempt is not a black box, and
  // the path it answers with, which is what the abandon comment points at.
  it("writeResolveAttempt files an attempt beside the gate artefact and answers with its path", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const c = logger.landing(1);

    const path = await c.writeResolveAttempt("64", {
      attempt: 2,
      issueId: "64",
      mode: "still-conflicted",
      stdout: "agent said this",
      stderr: "agent complained about that",
      end: "exit",
      exitCode: 1,
      signal: null,
      durationMs: 6_300,
      container: "sandbar-wdeadbeef-resolve-2-uuid",
    });

    expect(path).toBe(
      join(logger.runDir, "landing-1", "resolve-64-attempt-2.log"),
    );
    const body = await readFile(path, "utf8");
    expect(body).toContain("agent said this");
    expect(body).toContain("agent complained about that");
    expect(body).toContain("sandbar-wdeadbeef-resolve-2-uuid");
    expect(body).toContain("6300ms");
  });

  // The header is the whole artefact on the failure this file exists for: a
  // container that died at startup has neither stream to show.
  it("writes a readable header even when both streams are empty", async () => {
    const base = await makeBase();
    const logger = await startRunLogger({ baseDir: base });
    const path = await logger.landing(2).writeResolveAttempt("chunk-42", {
      attempt: 1,
      issueId: "42",
      mode: "still-conflicted",
      stdout: "",
      stderr: "",
      end: "spawn-error",
      exitCode: null,
      signal: null,
      durationMs: 12,
      container: "sandbar-wdeadbeef-resolve-1-uuid",
      detail: "spawn podman ENOENT",
    });

    expect(path).toContain("resolve-chunk-42-attempt-1.log");
    const body = await readFile(path, "utf8");
    expect(body).toContain("spawn-error (spawn podman ENOENT)");
    expect(body).toContain("stdout:     0 bytes");
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
