// `reflect` over a real logs tree and a real bare cache, with the agents
// stubbed: what is called, what is cached, and what the report says.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveConfig, type RunConfig } from "./config.js";
import {
  EVIDENCE_MAX_CHARS,
  evidenceFiles,
  evidencePath,
  memberProseKey,
  reflect,
  type InvokeResult,
  type Invoker,
  type ReflectStep,
} from "./reflect.js";

const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

const git = (args: readonly string[]): string => execFileSync("git", [...args], {
  encoding: "utf8",
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
});

const RUN = "run-2026-09-05T00-00-00-000Z";
const agent = { provider: "claude", model: "m", effort: null, durationMs: 1 };

// A run in which issues 7 and 8 each had a quality fix that committed, with
// the fixer's speech in its log.
async function writeLogs(logs: string, issues: readonly number[]): Promise<void> {
  const run = join(logs, RUN);
  await mkdir(run, { recursive: true });
  let seq = 0;
  const row = (fields: object): string =>
    JSON.stringify({ ts: "2026-09-05T00:00:00Z", seq: ++seq, ...fields });
  const rows = [row({ kind: "run-start", schemaVersion: 6, driver: "sandbar test", configPath: null,
    workdir: "/w", maxParallelIssues: 1, pid: 1 })];
  for (const issue of issues) {
    rows.push(row({ kind: "quality-pass", issue, title: "t", attempt: 1, round: 1, ...agent, result: "completed",
      commits: ["c"], discarded: {}, transcript: "quality-1.log" }));
    await mkdir(join(run, `issue-${issue}`), { recursive: true });
    await writeFile(join(run, `issue-${issue}`, "quality-1.log"),
      `header\n--- speech ---\nRemoved a wrapper around one call in issue ${issue}.\n--- stdout tail ---\n`);
  }
  await writeFile(join(run, "events.jsonl"), `${rows.join("\n")}\n`);
}

// A consumer whose bare cache has `origin/main` holding its CLAUDE.md.
async function consumer(claudeMd = "# Conventions\n"): Promise<{ readonly dir: string; readonly logs: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sandbar-reflect-"));
  temporaryDirectories.add(dir);
  const source = join(dir, "source");
  await mkdir(source);
  git(["init", "-q", "-b", "main", source]);
  await writeFile(join(source, "CLAUDE.md"), claudeMd);
  git(["-C", source, "add", "-A"]);
  git(["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const cache = join(dir, ".sandbar", "repo.git");
  git(["clone", "-q", "--bare", source, cache]);
  git([`--git-dir=${cache}`, "update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
  return { dir, logs: join(dir, ".sandbar", "logs") };
}

const configOf = (dir: string, fields: Partial<RunConfig> = {}) => resolveConfig({
  ghOwner: "acme",
  ghRepo: "app",
  developers: "anyone",
  sandboxImage: "localhost/sandbox",
  cwd: dir,
  gateStack: {
    containers: [{ name: "runner", image: "localhost/sandbox", mountWorktree: "/w", hold: true }],
    steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
  },
  ...fields,
});

const TAGS = "F1 R3 :: a wrapper around one call\nF2 R3 :: a wrapper around one call\n<tags-end/>";
const PROPOSALS = [
  "<proposals>",
  "@proposal",
  "category: prose-edit",
  "repo: consumer",
  "target: consumer/CLAUDE.md",
  "evidence: tag:quality:R3",
  "title: Say when a helper earns its keep",
  "",
  "Add a line on single-call wrappers.",
  "</proposals>",
].join("\n");

// The agents, stubbed: every call is recorded and answered by `answers`.
function stub(answers: Partial<Record<ReflectStep, string | InvokeResult>> = {}) {
  const calls: string[] = [];
  const workspaces: string[] = [];
  const prompts = new Map<string, string>();
  const openInvoker = (workspace: string): Invoker => ({
    invoke: async (step, prompt, name) => {
      calls.push(name);
      prompts.set(name, prompt);
      workspaces.push(workspace);
      const answer = answers[step] ?? (step === "tagger" ? TAGS : PROPOSALS);
      return typeof answer === "string" ? { answer, usage: { inputTokens: 100, outputTokens: 10 } } : answer;
    },
    close: async () => undefined,
  });
  return { calls, workspaces, prompts, openInvoker };
}

const run = (dir: string, logs: string, agents: ReturnType<typeof stub>, fields: Partial<RunConfig> = {}) =>
  reflect(configOf(dir, fields), { logsDir: logs, window: { last: 10 }, agents: true, openInvoker: agents.openInvoker });

describe("reflect (#182, #208)", () => {
  it("tags, synthesizes, and renders proposals with the evidence the driver resolved", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    const agents = stub();
    const { report, reportPath } = await run(dir, logs, agents);
    expect(agents.calls).toEqual(["tagger quality 1/1", "synthesizer"]);
    const taggerPrompt = agents.prompts.get("tagger quality 1/1");
    expect(taggerPrompt).toContain("- `R3`: ");
    expect(taggerPrompt).toContain("### F1 (issue #7)");
    expect(report).toContain("## Proposals: consumer, prose-edit");
    expect(report).toContain(`- acme/app#7: \`${join(logs, RUN, "issue-7")}/quality-1.log\``);
    expect(report).toContain("| `tag:quality:R3` | 2 | 2 |");
    expect(report).toContain("tagger quality 1/1: cache");
    expect(await readFile(reportPath, "utf8")).toBe(report);
    // The workspace is gone, and the cache holds the two answers.
    expect(await readdir(join(dir, ".sandbar", "reflect"))).toEqual([
      "cache", expect.stringMatching(/^report-.*\.md$/),
    ]);
    expect(await readdir(join(dir, ".sandbar", "reflect", "cache"))).toHaveLength(2);
  });

  it("answers a re-run from the cache, byte for byte, at no call", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    const first = await run(dir, logs, stub());
    const again = stub();
    const second = await run(dir, logs, again);
    expect(again.calls).toEqual([]);
    expect(second).toEqual(first);
  });

  it("misses the cache for a changed model, input or workspace, and only for the step it changed", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    await run(dir, logs, stub());

    const model = stub();
    await run(dir, logs, model, { reflectSynthesizerModelId: "opus-next" });
    expect(model.calls).toEqual(["synthesizer"]);

    const effort = stub();
    await run(dir, logs, effort, { reflectSynthesizerEffort: "max" });
    expect(effort.calls).toEqual(["synthesizer"]);

    const doc = stub();
    await writeFile(join(dir, "source", "CLAUDE.md"), "# Conventions, edited\n");
    git(["-C", join(dir, "source"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "edit"]);
    git(["-C", join(dir, ".sandbar", "repo.git"), "fetch", "-q", join(dir, "source"), "main:refs/remotes/origin/main"]);
    await run(dir, logs, doc);
    expect(doc.calls).toEqual(["synthesizer"]);

    const input = stub({ tagger: "F1 R3 :: a wrapper\nF2 R3 :: a wrapper\nF3 R3 :: a wrapper\n<tags-end/>" });
    await writeLogs(logs, [7, 8, 9]);
    await run(dir, logs, input);
    expect(input.calls).toEqual(["tagger quality 1/1", "synthesizer"]);
  });

  it("refuses a garbled cache file, naming it", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    await run(dir, logs, stub());
    const cacheDir = join(dir, ".sandbar", "reflect", "cache");
    const [file] = await readdir(cacheDir);
    const path = join(cacheDir, file ?? "");
    await writeFile(path, "{not json");
    await expect(run(dir, logs, stub())).rejects.toThrow(/is not JSON; delete it/);
    await writeFile(path, JSON.stringify({ usage: {} }));
    await expect(run(dir, logs, stub())).rejects.toThrow(/is not a cached answer; delete it/);
  });

  it("closes the invoker and removes the workspace, and throws the step's error, when a call rejects", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    let closed = 0;
    const openInvoker = (): Invoker => ({
      invoke: () => Promise.reject(new Error("invoke broke")),
      close: () => {
        closed += 1;
        return Promise.reject(new Error("close broke"));
      },
    });
    await expect(reflect(configOf(dir), { logsDir: logs, window: { last: 10 }, agents: true, openInvoker }))
      .rejects.toThrow("invoke broke");
    expect(closed).toBe(1);
    expect((await readdir(join(dir, ".sandbar", "reflect"))).filter((name) => name.startsWith("ws-"))).toEqual([]);
  });

  it("refuses a step routed to a provider no daemon role runs, before any podman", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    await expect(reflect(configOf(dir, { reflectTaggerAgent: "codex", reflectTaggerModelId: "gpt-5" }),
      { logsDir: logs, window: { last: 10 }, agents: true })).rejects.toThrow(/no daemon role runs/);
  });

  it("makes no call over a window where nothing recurs", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7]);
    const agents = stub({ tagger: "F1 R3 :: a wrapper around one call\n<tags-end/>" });
    const { report } = await run(dir, logs, agents);
    // The one finding is still tagged; one issue is no cluster, so no synthesis.
    expect(agents.calls).toEqual(["tagger quality 1/1"]);
    expect(report).toContain("## Proposals\n\nNone.");

    const empty = await consumer();
    const none = stub();
    await mkdir(empty.logs, { recursive: true });
    await run(empty.dir, empty.logs, none);
    expect(none.calls).toEqual([]);
  });

  it("lists a step that failed, keeps the tables, and does not cache the failure", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    const agents = stub({ tagger: "F1 R3 :: no end token" });
    const { report } = await run(dir, logs, agents);
    expect(agents.calls).toEqual(["tagger quality 1/1"]);
    expect(report).toContain("- tagger quality 1/1: parse: the answer does not end with <tags-end/>");
    expect(report).toContain("## Clusters");

    const wrote = stub({ synthesizer: { failure: "wrote: HEAD reflect at abc, status clean" } });
    const second = await run(dir, logs, wrote);
    expect(wrote.calls).toEqual(["tagger quality 1/1", "synthesizer"]);
    expect(second.report).toContain("- synthesizer: wrote: HEAD reflect at abc, status clean");
    expect(second.report).toContain("- `tag:quality:R3`\n");
  });

  it("tells each chunk of a bucket the slugs the earlier chunks minted (#182 Decision 4)", async () => {
    const { dir, logs } = await consumer();
    const dirOf = join(logs, RUN);
    let seq = 0;
    const row = (fields: object): string => JSON.stringify({ ts: "2026-09-05T00:00:00Z", seq: ++seq, ...fields });
    const rows = [row({ kind: "run-start", schemaVersion: 6, driver: "sandbar test", configPath: null,
      workdir: "/w", maxParallelIssues: 1, pid: 1 })];
    for (const issue of [7, 8]) {
      rows.push(
        row({ kind: "admitted", issue, title: "t", branch: `b-${issue}`, chunk: null, seedRef: "origin/main" }),
        row({ kind: "review-pass", issue, title: "t", attempt: 1, round: 1, invocation: 1, ...agent,
          result: "completed", transcript: "review-1.log" }),
        row({ kind: "review-round", issue, title: "t", attempt: 1, round: 1, head: "h", gateOk: true,
          correctness: "CHANGES-REQUESTED", rejectingPass: null, gateFailures: 0, correctnessFailures: 0,
          durationMs: 1 }),
      );
      await mkdir(join(dirOf, `issue-${issue}`), { recursive: true });
      // Over half the chunk bound each, so the bucket takes two calls.
      await writeFile(join(dirOf, `issue-${issue}`, "review-1.log"),
        `header\n--- speech ---\nNo guard on the empty list. ${"x".repeat(120_000)}\n--- stdout tail ---\n`);
    }
    await writeFile(join(dirOf, "events.jsonl"), `${rows.join("\n")}\n`);
    const prompts: string[] = [];
    const openInvoker = (): Invoker => ({
      invoke: async (step, prompt) => {
        if (step === "synthesizer") return { answer: "<proposals>\n</proposals>" };
        prompts.push(prompt);
        const id = prompt.includes("### F1 ") ? "F1" : "F2";
        return { answer: `${id} new:missing-empty-guard :: no guard on the empty list\n<tags-end/>` };
      },
      close: async () => undefined,
    });
    const { report } = await reflect(configOf(dir), { logsDir: logs, window: { last: 10 }, agents: true, openInvoker });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("No rule list, and no slug minted yet.");
    expect(prompts[1]).toContain("The slugs minted so far:\n\n- `new:missing-empty-guard`");
    expect(report).toContain("| `tag:correctness:new:missing-empty-guard` | 2 | 2 |");
    expect(report).toContain("## Not addressed\n\n- `tag:correctness:new:missing-empty-guard`");
  });

  it("renders only the tables under --no-agents, opening no workspace", async () => {
    const { dir, logs } = await consumer();
    await writeLogs(logs, [7, 8]);
    const agents = stub();
    const { report } = await reflect(configOf(dir), {
      logsDir: logs, window: { last: 10 }, agents: false, openInvoker: agents.openInvoker,
    });
    expect(agents.workspaces).toEqual([]);
    expect(report).toContain("- Agents: not run (`--no-agents`)");
    expect(report).not.toContain("## Proposals");
  });
});

describe("evidenceFiles (#182 Design)", () => {
  const members = [
    { run: "run-1", issue: 7, transcript: "quality-1.log" },
    { run: "run-1", issue: 8, transcript: "quality-1.log" },
  ];
  const files = evidenceFiles({
    clusters: [
      { key: "tag:quality:R3", issues: [7, 8], count: 2, members },
      { key: "gate:gate-1:unit tests/a", issues: [7, 8], count: 2,
        members: [{ run: "run-1", issue: 7, attempt: 1 }, { run: "run-1", issue: 8, attempt: 1 }] },
    ],
    candidates: [{ key: "rule:quality:R6", title: "Non-atomic orchestration.", listerIssues: 31 }],
    outliers: [{ issue: 9, rounds: 11, attempts: 4, specGaps: 2, outcome: "DONE", reason: null }],
    gists: new Map([["tag:quality:R3", ["g1", "g2", "g3", "g4", "g5", "g6"]]]),
    prose: new Map([
      [memberProseKey(members[0]!), "short"],
      [memberProseKey(members[1]!), "y".repeat(EVIDENCE_MAX_CHARS)],
    ]),
  });

  it("lists every citable key with up to five gists, and points at the raw prose it wrote", () => {
    const clusters = files.get("evidence/clusters.md") ?? "";
    expect(clusters).toContain("### `tag:quality:R3`\n\nIssues #7, #8; 2 members. Raw prose: `evidence/tag:quality:R3.md`.");
    expect(clusters).toContain("- g5\n");
    expect(clusters).not.toContain("g6");
    expect(clusters).toContain("- `rule:quality:R6`: Non-atomic orchestration. No tag hit over 31 lister issues.");
    expect(clusters).toContain("- `outlier:9`: #9 DONE after 11 rounds, 4 attempts, 2 spec gaps.");
    // A gate cluster has no speech, so no raw file.
    expect([...files.keys()]).toEqual(["evidence/clusters.md", "evidence/tag:quality:R3.md"]);
  });

  it("caps a cluster's raw prose", () => {
    const raw = files.get(evidencePath("tag:quality:R3")) ?? "";
    expect(raw.startsWith("# `tag:quality:R3`\n\n## #7 `quality-1.log`\n\nshort\n")).toBe(true);
    expect(raw.endsWith(`\n\n[capped at ${EVIDENCE_MAX_CHARS} chars]\n`)).toBe(true);
    expect(raw.length).toBeLessThan(EVIDENCE_MAX_CHARS + 100);
  });

  it("names a file for any key, distinctly", () => {
    expect(evidencePath("gate:gate-1:unit tests/a")).toBe("evidence/gate:gate-1:unit%20tests%2fa.md");
    expect(evidencePath("a/b")).not.toBe(evidencePath("a%2fb"));
  });
});
