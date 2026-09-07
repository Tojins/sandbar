import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTranscriptTree } from "./logs.js";

const makeRun = async () => {
  const base = await mkdtemp(join(tmpdir(), "sandbar-transcripts-"));
  return createTranscriptTree(join(base, "run-test"));
};

describe("raw transcript tree", () => {
  it("writes attempts without creating an orchestration log", async () => {
    const tree = await makeRun();
    const issue = await tree.issue("47");
    await issue.writeAttempt("47", 2, "implementer stdout");
    await issue.writeAttemptReviewer("47", 2, "reviewer stdout");
    expect((await readdir(tree.runDir)).sort()).toEqual(["issue-47"]);
    expect(await readFile(join(issue.dir, "attempt-2.log"), "utf8")).toBe("implementer stdout");
  });

  it("keeps merger and resolve transcripts as raw artefacts", async () => {
    const tree = await makeRun();
    const landing = tree.landing(1);
    await landing.appendMerger("merge branch");
    const path = await landing.writeResolveAttempt("64", {
      attempt: 2, issueId: "64", mode: "still-conflicted",
      stdout: "agent said this", stderr: "agent complained", end: "exit",
      exitCode: 1, signal: null, durationMs: 6300,
      container: "sandbar-wdeadbeef-resolve-2-uuid",
    });
    expect(await readFile(join(landing.dir, "merger.log"), "utf8")).toContain("merge branch");
    expect(await readFile(path, "utf8")).toContain("agent said this");
  });
});
