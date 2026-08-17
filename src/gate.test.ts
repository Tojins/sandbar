import { describe, expect, it } from "vitest";

import {
  analyzeTimeouts,
  lastNLines,
  stripAnsi,
  summarizeGateFailure,
} from "./gate.js";

describe("stripAnsi", () => {
  it("removes SGR colour codes, leaving the text intact", () => {
    // The shape vitest emits — exactly what leaked into issue #396's comment.
    const colored = "\x1b[31m\x1b[1m FAIL \x1b[22m\x1b[49m queries.test.ts";
    expect(stripAnsi(colored)).toBe(" FAIL  queries.test.ts");
  });

  it("strips cursor/erase CSI sequences too, not just colours", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b[1;5Hc")).toBe("abc");
  });

  it("is a no-op on text with no escapes", () => {
    expect(stripAnsi("plain line\nsecond line")).toBe("plain line\nsecond line");
  });

  it("leaves a literal caret-bracket (already-mangled) string alone", () => {
    // We strip real ESC bytes, not the printable mojibake; the fix is at the
    // source so the mojibake never gets produced in the first place.
    expect(stripAnsi("^[[90m209|")).toBe("^[[90m209|");
  });
});

describe("lastNLines", () => {
  it("keeps the trailing n lines", () => {
    expect(lastNLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });
});

// #15 — collapse uninformative timeout cascades and surface the root.
function cascadeOutput(n: number, ms = 5000): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(` FAIL  src/feature-${i}.test.ts > does a thing`);
    lines.push(`Error: Test timed out in ${ms}ms.`);
    lines.push(` ❯ src/feature-${i}.test.ts:3:1`);
  }
  lines.push(`Tests  ${n} failed (${n})`);
  return lines.join("\n");
}

describe("analyzeTimeouts", () => {
  it("counts identical-signature timeouts and flags the cascade", () => {
    const a = analyzeTimeouts(cascadeOutput(681));
    expect(a.timeoutCount).toBe(681);
    expect(a.dominantMs).toBe(5000);
    expect(a.dominantCount).toBe(681);
    expect(a.firstDominant).toBe("Error: Test timed out in 5000ms.");
    expect(a.isCascade).toBe(true);
  });

  it("does not flag a couple of independent timeouts as a cascade", () => {
    const a = analyzeTimeouts(cascadeOutput(2));
    expect(a.timeoutCount).toBe(2);
    expect(a.isCascade).toBe(false);
  });

  it("picks the dominant duration when timeouts have mixed budgets", () => {
    const mixed = [
      "Error: Test timed out in 5000ms.",
      "Error: Test timed out in 5000ms.",
      "Error: Test timed out in 5000ms.",
      "Error: Test timed out in 10000ms.",
    ].join("\n");
    const a = analyzeTimeouts(mixed);
    expect(a.timeoutCount).toBe(4);
    expect(a.dominantMs).toBe(5000);
    expect(a.dominantCount).toBe(3);
    expect(a.isCascade).toBe(true);
  });

  it("reports no cascade on output with no timeouts", () => {
    const a = analyzeTimeouts("AssertionError: expected 1 to be 2\n FAIL x");
    expect(a.timeoutCount).toBe(0);
    expect(a.dominantMs).toBeNull();
    expect(a.isCascade).toBe(false);
  });
});

describe("summarizeGateFailure", () => {
  it("collapses the cascade to one occurrence plus a count", () => {
    const out = summarizeGateFailure(cascadeOutput(681), 200);
    // The header echoes the root once; below the rule separator exactly one raw
    // timeout line survives, the rest folded into the marker.
    const body = out.split("─".repeat(60))[1] ?? "";
    const timeoutLines = body
      .split("\n")
      .filter((l) => /Test timed out in 5000ms/.test(l));
    expect(timeoutLines.length).toBe(1);
    expect(out).toContain("and 680 more test(s) timed out identically");
  });

  it("leads with the environment-cascade hint and the root failure", () => {
    const out = summarizeGateFailure(cascadeOutput(681), 200);
    expect(out).toContain("Probable environment/setup failure (timeout cascade)");
    expect(out).toContain("681 tests failed with the identical signature");
    expect(out).toContain("Earliest timeout (likely root):");
    expect(out).toContain("Error: Test timed out in 5000ms.");
    // The hint sits above the truncation boundary, not buried after it.
    const hintIdx = out.indexOf("Probable environment/setup failure");
    const ruleIdx = out.indexOf("─".repeat(60));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeLessThan(ruleIdx);
  });

  it("surfaces the root even when the raw cascade would overflow the tail", () => {
    // 681*3 ≈ 2000 lines: tail-only truncation to 200 would drop the first
    // failure entirely. Collapsing first keeps it.
    const out = summarizeGateFailure(cascadeOutput(681), 200);
    expect(out).toContain("src/feature-0.test.ts");
  });

  it("is a plain tail (no hint) when there is no cascade", () => {
    const noCascade = cascadeOutput(2);
    expect(summarizeGateFailure(noCascade, 200)).toBe(lastNLines(noCascade, 200));
  });

  it("leaves a non-timeout failure trace untouched", () => {
    const assertion = "AssertionError: expected 1 to be 2\n FAIL src/x.test.ts";
    expect(summarizeGateFailure(assertion, 200)).toBe(
      lastNLines(assertion, 200),
    );
  });
});
