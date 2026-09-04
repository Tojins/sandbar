import { describe, expect, it } from "vitest";

import type { Terminal } from "./inner-loop.js";
import { formatTerminalLine } from "./run.js";

describe("formatTerminalLine (#115)", () => {
  const terminals: readonly [string, Terminal][] = [
    ["DONE", { type: "DONE", commits: [] }],
    [
      "NEEDS-INFO",
      { type: "NEEDS-INFO", questions: "question", strandedHead: null },
    ],
    [
      "NEEDS-UI-PROTOTYPE",
      {
        type: "NEEDS-UI-PROTOTYPE",
        uiImpact: "impact",
        commits: [],
        strandedHead: null,
      },
    ],
    [
      "NEEDS-HUMAN",
      {
        type: "NEEDS-HUMAN",
        cause: "gate-red",
        failureTrace: "trace",
        latestReviewerProse: null,
        strandedHead: null,
      },
    ],
    [
      "NEEDS-HUMAN-REVIEW",
      {
        type: "NEEDS-HUMAN-REVIEW",
        latestReviewerProse: "review",
        commits: [],
      },
    ],
    ["QUOTA", { type: "QUOTA", provider: "codex", window: "five_hour" }],
  ];

  it.each(terminals)("leaves the %s terminal payload-free", (_name, terminal) => {
    expect(formatTerminalLine("115", terminal, "durationMs=42")).toBe(
      `terminal #115 ${terminal.type} durationMs=42`,
    );
  });

  it.each([
    ["single-line", "podman socket refused"],
    ["multi-line", "bringup failed\nstack frame\nlast frame"],
    ["empty", ""],
  ])("appends the %s HARD-ERROR reason verbatim", (_name, reason) => {
    expect(
      formatTerminalLine(
        "115",
        { type: "HARD-ERROR", reason, commits: [] },
        "durationMs=42",
      ),
    ).toBe(`terminal #115 HARD-ERROR durationMs=42: ${reason}`);
  });
});
