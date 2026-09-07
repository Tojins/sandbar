import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readEventsFile, runStampFromDate, startEventRecord } from "./events.js";

const start = {
  driver: "sandbar test", configPath: "/repo/sandbar.config.mjs",
  workdir: "/repo/.sandbar", maxParallelIssues: 3, pid: 42,
} as const;

describe("event record", () => {
  it("serializes concurrent emissions in monotonic sequence", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "sandbar-events-"));
    const record = await startEventRecord({
      baseDir, now: new Date("2026-05-05T21:15:32.101Z"), start,
    });
    await Promise.all([
      record.emit({ kind: "complaint", severity: "warning", message: "one" }),
      record.emit({ kind: "complaint", severity: "error", message: "two" }),
    ]);
    await record.finalize("done");
    await record.finalize("ignored");
    const events = await readEventsFile(record.eventsPath);
    expect(events.map((event) => [event.seq, event.kind])).toEqual([
      [1, "run-start"], [2, "complaint"], [3, "complaint"], [4, "run-end"],
    ]);
    expect(await readFile(record.eventsPath, "utf8")).toMatch(/\n$/);
  });

  it("refuses an unknown schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-events-"));
    const path = join(dir, "events.jsonl");
    await writeFile(path, JSON.stringify({ seq: 1, ts: "x", kind: "run-start", schemaVersion: 99 }) + "\n");
    await expect(readEventsFile(path)).rejects.toThrow(/Unsupported sandbar event schema 99/);
  });

  it.each([
    ["duplicate", [1, 1]],
    ["skipped", [1, 3]],
    ["out-of-order", [1, 3, 2]],
  ])("refuses a %s sequence", async (_name, sequences) => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-events-"));
    const path = join(dir, "events.jsonl");
    const rows = sequences.map((seq, index) => index === 0 ? {
      ...start, kind: "run-start", schemaVersion: 1, seq, ts: "2026-09-07T10:00:00Z",
    } : { kind: "complaint", severity: "warning", message: String(index), seq,
      ts: "2026-09-07T10:00:01Z" });
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await expect(readEventsFile(path)).rejects.toThrow(/Non-monotonic event sequence/);
  });

  it("ignores an unterminated append tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-events-"));
    const path = join(dir, "events.jsonl");
    await writeFile(path, `${JSON.stringify({
      ...start,
      kind: "run-start",
      schemaVersion: 1,
      seq: 1,
      ts: "2026-09-07T10:00:00Z",
    })}\n{\"kind\":\"compl`);
    await expect(readEventsFile(path)).resolves.toHaveLength(1);
  });

  it("makes filesystem-safe run stamps", () => {
    expect(runStampFromDate(new Date("2026-05-05T21:15:32.101Z")))
      .toBe("2026-05-05T21-15-32-101Z");
  });
});
