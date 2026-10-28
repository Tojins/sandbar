import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EVENT_SCHEMA_VERSION, parseEventLines } from "./events.js";
import {
  normalizeV5,
  normalizeV6,
  readStatsInput,
  selectRuns,
  speechSection,
} from "./stats-record.js";

const temporaryDirectories = new Set<string>();
const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "sandbar-stats-record-"));
  temporaryDirectories.add(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

const runStart = (schemaVersion: unknown) => ({
  kind: "run-start", schemaVersion, driver: "sandbar test", configPath: null,
  workdir: "/repo/.sandbar", maxParallelIssues: 1, pid: 1, seq: 1, ts: "2026-09-07T10:00:00Z",
});

const jsonl = (rows: readonly object[]): string =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe("selectRuns (#194)", () => {
  const dirs = [
    "run-2026-09-03T08-00-00-000Z",
    "run-2026-09-01T10-00-00-000Z",
    "images",
    "run-2026-09-02T09-00-00-000Z",
  ];

  it.each([
    ["the last N, oldest first", { last: 2 }, [
      "run-2026-09-02T09-00-00-000Z", "run-2026-09-03T08-00-00-000Z",
    ]],
    ["more than there are", { last: 10 }, [
      "run-2026-09-01T10-00-00-000Z", "run-2026-09-02T09-00-00-000Z",
      "run-2026-09-03T08-00-00-000Z",
    ]],
    ["since a date, that day included", { since: "2026-09-02" }, [
      "run-2026-09-02T09-00-00-000Z", "run-2026-09-03T08-00-00-000Z",
    ]],
    ["since a date after every run", { since: "2026-10-01" }, []],
  ] as const)("selects %s", (_name, window, expected) => {
    expect(selectRuns(dirs, window)).toEqual(expected);
  });

  it("selects nothing from no runs", () => {
    expect(selectRuns(["images"], { last: 10 })).toEqual([]);
  });
});

describe("parseEventLines (#194)", () => {
  it("returns any schema's events for the caller to judge", () => {
    const parsed = parseEventLines(
      jsonl([runStart(99), { kind: "novel", seq: 2, ts: "x" }]),
      "events.jsonl",
    );
    expect(parsed.schemaVersion).toBe(99);
    expect(parsed.events.map((event) => event.kind)).toEqual(["run-start", "novel"]);
  });

  it.each([
    ["bad JSON", "{nope\n", /Invalid event JSON at line 1/],
    ["a record not opened by run-start", jsonl([{ kind: "notice", seq: 1 }]), /does not begin with run-start/],
    ["a sequence gap", jsonl([runStart(5), { kind: "notice", seq: 3 }]), /Non-monotonic event sequence/],
  ])("refuses %s", (_name, body, message) => {
    expect(() => parseEventLines(body, "events.jsonl")).toThrow(message);
  });
});

describe("normalisers (#194)", () => {
  const event = (fields: Record<string, unknown>) => ({ seq: 2, ts: "x", issue: 7, ...fields });

  it("names the correctness pass on a schema-5 adjudication", () => {
    const { events } = normalizeV5([
      runStart(5),
      event({ kind: "adjudication", attempt: 1, round: 1, head: "h", ruling: "UPHELD" }),
    ]);
    expect(events[1]).toMatchObject({ kind: "adjudication", pass: "correctness" });
  });

  it("leaves a schema-5 review-round without a quality outcome", () => {
    const { events } = normalizeV5([
      runStart(5),
      event({ kind: "review-round", attempt: 1, round: 1, correctness: "APPROVED" }),
    ]);
    expect(events[1]).not.toHaveProperty("quality");
    expect(events[1]).not.toHaveProperty("qualityRounds");
  });

  it("counts a kind its schema does not define and drops it", () => {
    expect(normalizeV5([runStart(5), event({ kind: "quality-review" })])).toEqual({
      events: [runStart(5)],
      ignoredKinds: { "quality-review": 1 },
    });
    expect(normalizeV6([
      runStart(6), event({ kind: "scenario-runner" }), event({ kind: "scenario-runner" }),
    ])).toEqual({ events: [runStart(6)], ignoredKinds: { "scenario-runner": 2 } });
  });

  it("passes a schema-6 event through", () => {
    const review = event({ kind: "quality-review", mode: "list", verdict: "APPROVED" });
    expect(normalizeV6([runStart(6), review]).events).toEqual([runStart(6), review]);
  });
});

describe("speechSection (#182)", () => {
  it("lifts the speech between its heading and the stdout tail", () => {
    expect(speechSection(
      "agent: x\n\n--- speech ---\nfirst\nsecond\n--- stdout tail ---\nraw\n",
    )).toBe("first\nsecond");
  });

  it("reads empty speech as empty and a log without the section as none", () => {
    expect(speechSection("h\n--- speech ---\n\n--- stdout tail ---\n")).toBe("");
    expect(speechSection("no sections here")).toBeNull();
  });
});

describe("readStatsInput (#194)", () => {
  it("reads supported runs and lists every other run as skipped, whole", async () => {
    const logs = await makeTemporaryDirectory();
    const write = async (run: string, body: string): Promise<void> => {
      await mkdir(join(logs, run), { recursive: true });
      await writeFile(join(logs, run, "events.jsonl"), body);
    };
    await write("run-2026-09-01T00-00-00-000Z", jsonl([runStart(2)]));
    await mkdir(join(logs, "run-2026-09-02T00-00-00-000Z"));
    await writeFile(join(logs, "run-2026-09-02T00-00-00-000Z", "orchestrator.log"), "old\n");
    await write("run-2026-09-03T00-00-00-000Z", "{broken\n");
    await write("run-2026-09-04T00-00-00-000Z", jsonl([
      runStart(5),
      { kind: "adjudication", issue: 7, seq: 2, ts: "x", ruling: "OVERRULED" },
    ]));
    await write("run-2026-09-05T00-00-00-000Z", jsonl([
      runStart(EVENT_SCHEMA_VERSION),
      { kind: "review-pass", issue: 7, seq: 2, ts: "x", transcript: "attempt-1-reviewer-1.log" },
      { kind: "review-pass", issue: 7, seq: 3, ts: "x", transcript: "attempt-1-reviewer-2.log" },
      { kind: "scenario-writer", issue: 7, seq: 4, ts: "x" },
    ]));
    await mkdir(join(logs, "run-2026-09-05T00-00-00-000Z", "issue-7"));
    await writeFile(
      join(logs, "run-2026-09-05T00-00-00-000Z", "issue-7", "attempt-1-reviewer-1.log"),
      "header\n\n--- speech ---\n<verdict>APPROVED</verdict>\n--- stdout tail ---\n",
    );
    await mkdir(join(logs, "images"));

    const input = await readStatsInput(logs, { last: 10 }, { withProse: true });

    expect(input.skipped).toEqual([
      { run: "run-2026-09-01T00-00-00-000Z", reason: "unsupported event schema 2", schemaVersion: 2 },
      { run: "run-2026-09-02T00-00-00-000Z", reason: "no events.jsonl" },
      {
        run: "run-2026-09-03T00-00-00-000Z",
        reason: expect.stringContaining("Invalid event JSON at line 1"),
      },
    ]);
    expect(input.runs.map(({ run, schemaVersion, driver }) => ({ run, schemaVersion, driver })))
      .toEqual([
        { run: "run-2026-09-04T00-00-00-000Z", schemaVersion: 5, driver: "sandbar test" },
        { run: "run-2026-09-05T00-00-00-000Z", schemaVersion: 6, driver: "sandbar test" },
      ]);
    expect(input.runs[0]?.events[1]).toMatchObject({ kind: "adjudication", pass: "correctness" });
    expect(input.ignoredKinds).toEqual({ "scenario-writer": 1 });
    // The second transcript's log is gone: its prose is absent, not empty.
    expect([...input.runs[1]!.prose]).toEqual([
      ["7/attempt-1-reviewer-1.log", "<verdict>APPROVED</verdict>"],
    ]);
  });

  it("reads no prose unless asked", async () => {
    const logs = await makeTemporaryDirectory();
    await mkdir(join(logs, "run-2026-09-05T00-00-00-000Z", "issue-7"), { recursive: true });
    await writeFile(join(logs, "run-2026-09-05T00-00-00-000Z", "events.jsonl"), jsonl([
      runStart(6),
      { kind: "review-pass", issue: 7, seq: 2, ts: "x", transcript: "a.log" },
    ]));
    await writeFile(
      join(logs, "run-2026-09-05T00-00-00-000Z", "issue-7", "a.log"),
      "--- speech ---\nsaid\n--- stdout tail ---\n",
    );
    const input = await readStatsInput(logs, { last: 10 }, { withProse: false });
    expect(input.runs[0]?.prose.size).toBe(0);
  });

  it("reads a logs directory that does not exist as no runs", async () => {
    const logs = join(await makeTemporaryDirectory(), "absent");
    await expect(readStatsInput(logs, { last: 10 }, { withProse: false })).resolves.toEqual({
      window: { last: 10 }, withProse: false, runs: [], skipped: [], ignoredKinds: {},
    });
  });
});
