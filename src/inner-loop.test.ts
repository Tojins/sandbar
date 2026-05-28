import { describe, expect, it } from "vitest";
import { decideAfterGate2 } from "./inner-loop.js";

describe("decideAfterGate2", () => {
  it("DONE when gate-2 green and reviewer made no commits", () => {
    expect(decideAfterGate2(true, 0)).toBe("DONE");
  });

  it("DONE when gate-2 green and reviewer made commits", () => {
    expect(decideAfterGate2(true, 3)).toBe("DONE");
  });

  it("REVERT-THEN-DONE when gate-2 red but reviewer made commits", () => {
    expect(decideAfterGate2(false, 1)).toBe("REVERT-THEN-DONE");
    expect(decideAfterGate2(false, 7)).toBe("REVERT-THEN-DONE");
  });

  it("HARD-ERROR when gate-2 red and reviewer made no commits (infra flake)", () => {
    expect(decideAfterGate2(false, 0)).toBe("HARD-ERROR");
  });
});
