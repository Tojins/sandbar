import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentInvocationFilename,
  createAgentInvocationSequencer,
  createTranscriptTree,
} from "./logs.js";

const temporaryDirectories = new Set<string>();

const makeRun = async () => {
  const base = await mkdtemp(join(tmpdir(), "sandbar-transcripts-"));
  temporaryDirectories.add(base);
  return createTranscriptTree(join(base, "run-test"));
};

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
  temporaryDirectories.clear();
});

describe("agent invocation records (#135)", () => {
  it.each([
    [{ role: "implementer", attempt: 3, nudge: false }, "attempt-3.log"],
    [{ role: "implementer", attempt: 3, nudge: true }, "attempt-3-nudge.log"],
    [{ role: "quality-list", attempt: 3, group: "naming", invocation: 2 }, "attempt-3-quality-list-naming-2.log"],
    [{ role: "quality-fix", attempt: 3, fixRound: 2, invocation: 1 }, "attempt-3-quality-fix-2-1.log"],
    [{ role: "quality-verify", attempt: 3, fixRound: 2, invocation: 1 }, "attempt-3-quality-verify-2-1.log"],
    [
      { role: "quality-adjudicator", attempt: 3, fixRound: 2, invocation: 2 },
      "attempt-3-quality-adjudicator-2-2.log",
    ],
    [{ role: "reviewer", attempt: 3, invocation: 2 },
      "attempt-3-reviewer-2.log"],
    [{ role: "adjudicator", attempt: 3, invocation: 1 },
      "attempt-3-adjudicator-1.log"],
    [{ role: "gate", attempt: 3 }, "attempt-3-gate.log"],
    [{ role: "anchor-condense", invocation: 2 }, "anchor-condense-2.log"],
    [{ role: "ui-check", invocation: 2 }, "ui-check-2.log"],
    [{ role: "partition-check", invocation: 2 }, "partition-check-2.log"],
    [{ role: "scenario-writer", invocation: 2 }, "scenario-writer-2.log"],
  ] as const)("names %j as %s", (identity, expected) => {
    expect(agentInvocationFilename(identity)).toBe(expected);
  });

  it("numbers each pre-attempt role on its own run-wide counter across cycles", () => {
    const sequencer = createAgentInvocationSequencer();
    const first = sequencer.startCycle();
    expect(first.filename({ role: "anchor-condense", invocation: 1 })).toBe("anchor-condense-1.log");
    expect(first.filename({ role: "ui-check", invocation: 1 })).toBe("ui-check-1.log");
    expect(first.filename({ role: "ui-check", invocation: 2 })).toBe("ui-check-2.log");
    const second = sequencer.startCycle();
    expect(second.filename({ role: "anchor-condense", invocation: 1 })).toBe("anchor-condense-2.log");
    expect(second.filename({ role: "ui-check", invocation: 1 })).toBe("ui-check-3.log");
    expect(second.filename({ role: "partition-check", invocation: 1 })).toBe("partition-check-1.log");
    expect(second.filename({ role: "implementer", attempt: 1, nudge: false })).toBe("attempt-1.log");
  });

  // A later admission's writer owns a sequence started after the earlier one
  // named its files (#203).
  it("numbers the scenario writer across admissions", () => {
    const sequencer = createAgentInvocationSequencer();
    const first = sequencer.startCycle();
    expect(first.filename({ role: "scenario-writer", invocation: 1 })).toBe("scenario-writer-1.log");
    expect(first.filename({ role: "scenario-writer", invocation: 2 })).toBe("scenario-writer-2.log");
    expect(sequencer.startCycle().filename({ role: "scenario-writer", invocation: 1 }))
      .toBe("scenario-writer-3.log");
  });
});

describe("raw transcript tree", () => {
  it("writes attempts without creating an orchestration log", async () => {
    const tree = await makeRun();
    const issue = await tree.issue("47");
    await issue.writeInvocation("attempt-2.log", {
      agent: "implementer-47-attempt-2",
      provider: "codex",
      model: "gpt-5.6-sol",
      end: "exit",
      detail: null,
      exitCode: 0,
      durationMs: 42,
      peakMemoryBytes: 931_000_000,
      oomKilled: true,
      speech: "implementer speech",
      stdout: "implementer stdout",
      stderr: "implementer stderr",
      controlLines: ["{\"type\":\"system\"}", "{\"type\":\"result\"}"],
      commands: [
        { name: "Bash", args: "npm test", contextTokens: 41_250 },
        { name: "command_execution", args: "cat <<'EOF'\nbody\nEOF" },
      ],
    });
    expect((await readdir(tree.runDir)).sort()).toEqual(["issue-47"]);
    expect(await readFile(join(issue.dir, "attempt-2.log"), "utf8")).toBe(
      "agent:      implementer-47-attempt-2\n" +
      "provider:   codex\nmodel:      gpt-5.6-sol\nended:      exit\n" +
      "exit code:  0\nduration:   42ms\n" +
      "resources:  peakMemoryBytes=931000000 oomKilled=true\n\n" +
      "--- speech ---\nimplementer speech\n" +
      "--- stdout tail ---\nimplementer stdout\n" +
      "--- stderr tail ---\nimplementer stderr\n" +
      "--- commands ---\n[41250 tok] Bash: npm test\n" +
      "[-] command_execution: cat <<'EOF' …\n" +
      "--- control lines ---\n{\"type\":\"system\"}\n{\"type\":\"result\"}\n",
    );
    await expect(issue.writeInvocation("attempt-2.log", {
      agent: "replacement",
      provider: "codex",
      model: null,
      end: "exit",
      detail: null,
      exitCode: 0,
      durationMs: 1,
      speech: "replacement",
      stdout: "replacement",
      stderr: "",
      controlLines: [],
      commands: [],
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(issue.dir, "attempt-2.log"), "utf8"))
      .toContain("implementer speech");
  });

  it("files every gate-1 result beside the attempt that produced it (#153)", async () => {
    const tree = await makeRun();
    const issue = await tree.issue("153");
    await issue.writeGate("attempt-1-gate.log", {
      ok: false,
      stdout: "=== check ===\ntype error",
      stderr: "tsc said so",
      failedStep: "check",
      exitCode: 2,
      containerLogs: "--- container db (last 40 lines) ---\nconnection refused",
    });
    expect(await readFile(join(issue.dir, "attempt-1-gate.log"), "utf8")).toBe(
      "result:     red\nfailed:     check\nexit code:  2\n\n" +
      "--- stdout ---\n=== check ===\ntype error\n" +
      "--- stderr ---\ntsc said so\n" +
      "--- container logs ---\n--- container db (last 40 lines) ---\nconnection refused\n",
    );

    // Green too, and with the same sections, so the next red diffs against it.
    await issue.writeGate("attempt-2-gate.log", {
      ok: true, stdout: "=== check ===\n", stderr: "", failedStep: null,
      exitCode: 0, containerLogs: "",
    });
    expect(await readFile(join(issue.dir, "attempt-2-gate.log"), "utf8")).toBe(
      "result:     green\nfailed:     -\nexit code:  0\n\n" +
      "--- stdout ---\n=== check ===\n\n--- stderr ---\n\n--- container logs ---\n\n",
    );

    await expect(issue.writeGate("attempt-2-gate.log", {
      ok: true, stdout: "replacement", stderr: "", failedStep: null,
      exitCode: 0, containerLogs: "",
    })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("files each admission's issue snapshot create-only, in its own sequence (#195)", async () => {
    const tree = await makeRun();
    const issue = await tree.issue("195");
    const first = { title: "Replay", body: "as admitted", comments: [] };
    await expect(issue.writeIssueSnapshot(first)).resolves.toBe("issue-snapshot-1.json");
    await expect((await tree.issue("195")).writeIssueSnapshot({ title: "Replay", body: "edited" }))
      .resolves.toBe("issue-snapshot-2.json");
    expect(JSON.parse(await readFile(join(issue.dir, "issue-snapshot-1.json"), "utf8")))
      .toEqual(first);

    // A logger that lost the sequence must fail rather than erase the record.
    const restarted = await (await createTranscriptTree(tree.runDir)).issue("195");
    await expect(restarted.writeIssueSnapshot({ title: "replacement" }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(join(issue.dir, "issue-snapshot-1.json"), "utf8")))
      .toEqual(first);
  });

  it("files each scenario set create-only, in its own sequence, and answers with its path (#203)", async () => {
    const tree = await makeRun();
    const issue = await tree.issue("203");
    const set = {
      version: 1,
      issue: 203,
      seed: { ref: "origin/main", sha: "abc" },
      writer: { provider: "claude", model: "opus", effort: null },
      scenarios: [],
    } as const;
    await expect(issue.writeScenarios(set)).resolves.toBe(join(issue.dir, "scenarios-1.json"));
    await expect(issue.writeScenarios({ ...set, issue: 204 }))
      .resolves.toBe(join(issue.dir, "scenarios-2.json"));
    expect(JSON.parse(await readFile(join(issue.dir, "scenarios-1.json"), "utf8"))).toEqual(set);

    const restarted = await (await createTranscriptTree(tree.runDir)).issue("203");
    await expect(restarted.writeScenarios(set)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("keeps merger and resolve transcripts as raw artefacts", async () => {
    const tree = await makeRun();
    const landing = tree.landing(1);
    await landing.appendMerger("merge branch");
    await landing.writeMergerGate("64", {
      stdout: "gate stdout", stderr: "gate stderr", failedStep: "unit",
      exitCode: 7, containerLogs: "db tail",
    });
    const path = await landing.writeResolveAttempt("64", {
      attempt: 2, issueId: "64", mode: "still-conflicted",
      stdout: "agent said this", stderr: "agent complained", end: "exit",
      exitCode: 1, signal: null, durationMs: 6300,
      peakMemoryBytes: 344_000_000, oomKilled: false,
      container: "sandbar-wdeadbeef-resolve-2-uuid",
    });
    expect(await readFile(join(landing.dir, "merger.log"), "utf8")).toContain("merge branch");
    expect(await readFile(join(landing.dir, "merger-gate-64.out"), "utf8")).toBe("gate stdout");
    expect(await readFile(join(landing.dir, "merger-gate-64.err"), "utf8")).toBe("gate stderr");
    expect(await readFile(join(landing.dir, "merger-gate-64.containers.log"), "utf8")).toBe("db tail");
    expect(JSON.parse(await readFile(join(landing.dir, "merger-gate-64.meta.json"), "utf8")))
      .toEqual({ failedStep: "unit", exitCode: 7 });
    expect(await readFile(path, "utf8")).toBe(
      "resolve attempt 2 for #64 (mode=still-conflicted)\n" +
      "container:  sandbar-wdeadbeef-resolve-2-uuid\nended:      exit\n" +
      "exit code:  1\nsignal:     -\nduration:   6300ms\n" +
      "resources:  peakMemoryBytes=344000000\n" +
      "stdout:     15 bytes\nstderr:     16 bytes\n\n" +
      "--- stdout ---\nagent said this\n--- stderr ---\nagent complained\n",
    );
  });

  it("keeps the diagnostic header when a resolve process produced no streams", async () => {
    const tree = await makeRun();
    const path = await tree.landing(2).writeResolveAttempt("chunk-42", {
      attempt: 1, issueId: "42", mode: "still-conflicted", stdout: "", stderr: "",
      end: "spawn-error", exitCode: null, signal: null, durationMs: 12,
      container: "sandbar-wdeadbeef-resolve-1-uuid", detail: "spawn podman ENOENT",
    });
    expect(await readFile(path, "utf8")).toContain(
      "ended:      spawn-error (spawn podman ENOENT)\nexit code:  -\n" +
      "signal:     -\nduration:   12ms\nstdout:     0 bytes\nstderr:     0 bytes",
    );
  });
});
