import { describe, expect, it } from "vitest";

import { AgentCredentialError, AgentQuotaError } from "./agent-sandbox.js";
import type { ResolveAgentRun } from "./resolve-loop.js";

import {
  LANDING_PASS_MAX_ATTEMPTS,
  type CommitShape,
  type LandingPassAdapter,
  type LandingPassPromptInputs,
  buildLandingPassPrompt,
  commitShapeProblem,
  landingTouchesPaths,
  parseLandingPassSignal,
  runLandingPass,
} from "./landing-pass.js";

describe("landingTouchesPaths", () => {
  it.each([
    ["a file under a directory prefix", ["src/app/"], ["src/app/screen.ts"], true],
    ["a file deep under it", ["src/app/"], ["src/app/a/b/c.ts"], true],
    ["an exact file", ["services.php"], ["services.php"], true],
    ["a partial segment", ["src/app/"], ["src/apps/x.ts"], false],
    ["a file prefix without its slash", ["src/app"], ["src/app/x.ts"], false],
    ["a longer file name", ["services.php"], ["services.php.bak"], false],
    ["nothing changed", ["src/app/"], [], false],
    ["any of several prefixes", ["docs/", "src/app/"], ["README.md", "src/app/x.ts"], true],
  ] as const)("%s", (_, prefixes, changed, expected) => {
    expect(landingTouchesPaths(prefixes, changed)).toBe(expected);
  });

  it("runs on every landing without prefixes, even one changing nothing", () => {
    expect(landingTouchesPaths(null, [])).toBe(true);
  });
});

describe("parseLandingPassSignal", () => {
  it("reads DONE", () => {
    expect(parseLandingPassSignal("bumped it\n<promise>DONE</promise>")).toEqual({ kind: "DONE" });
  });

  it("reads ABANDON with its reason", () => {
    expect(parseLandingPassSignal(
      "<promise>ABANDON</promise>\n<reason>two screens claim version 5</reason>",
    )).toEqual({ kind: "ABANDON", reason: "two screens claim version 5" });
  });

  it("reads ABANDON without a reason", () => {
    expect(parseLandingPassSignal("<promise>ABANDON</promise>")).toEqual({
      kind: "ABANDON",
      reason: "(no reason given)",
    });
  });

  it("takes the last of both signals", () => {
    expect(parseLandingPassSignal("<promise>ABANDON</promise> then <promise>DONE</promise>"))
      .toEqual({ kind: "DONE" });
    expect(parseLandingPassSignal("<promise>DONE</promise> then <promise>ABANDON</promise>"))
      .toEqual({ kind: "ABANDON", reason: "(no reason given)" });
  });

  it("reads neither as no signal", () => {
    expect(parseLandingPassSignal("I looked and changed nothing.")).toEqual({ kind: "NO-SIGNAL" });
    expect(parseLandingPassSignal("<promise>COMMITTED</promise>")).toEqual({ kind: "NO-SIGNAL" });
  });
});

describe("commitShapeProblem", () => {
  const clean: CommitShape = {
    mergeInProgress: false,
    dirtyPaths: [],
    descends: true,
    commits: [{ sha: "c1", parents: 1 }, { sha: "c2", parents: 1 }],
  };

  it("keeps a clean single-parent chain on the merge", () => {
    expect(commitShapeProblem(clean)).toBeNull();
    expect(commitShapeProblem({ ...clean, commits: [] })).toBeNull();
  });

  it("refuses a merge commit after the merge", () => {
    expect(commitShapeProblem({ ...clean, commits: [{ sha: "c1", parents: 1 }, { sha: "m", parents: 2 }] }))
      .toBe("commit m has 2 parents, and only single-parent commits may follow the merge");
  });

  it("refuses an amended or rebased merge", () => {
    expect(commitShapeProblem({ ...clean, descends: false, commits: [] }))
      .toBe("HEAD no longer descended from the merge (amended, rebased or reset)");
  });

  it("refuses a dirty tree", () => {
    expect(commitShapeProblem({ ...clean, dirtyPaths: [" M src/app/a.ts"] }))
      .toBe("the worktree was left dirty ( M src/app/a.ts)");
  });

  it("refuses a merge left in progress", () => {
    expect(commitShapeProblem({ ...clean, mergeInProgress: true }))
      .toBe("a merge was left in progress");
  });
});

describe("buildLandingPassPrompt", () => {
  const base: LandingPassPromptInputs = {
    opening: { kind: "unit", label: "#12", branch: "sandbar/issue-12-x", preMergeSha: "pre" },
    target: "main",
    mergedSha: "merged",
    issues: [12],
    repoSlug: "acme/app",
    instructions: "Raise the client version when a screen's contract changed.",
    attempt: 1,
    retry: null,
  };

  it("names the merge, the range and the issue for an issue landing", () => {
    const prompt = buildLandingPassPrompt(base);
    expect(prompt).toContain("# Landing pass: #12");
    expect(prompt).toContain("#12, branch `sandbar/issue-12-x`, has just been merged onto `main`");
    expect(prompt).toContain("`git diff pre HEAD`");
    expect(prompt).toContain("- `gh issue view 12 --repo acme/app --json title,body`");
    expect(prompt).toContain("Raise the client version when a screen's contract changed.");
    expect(prompt).toContain(`# Attempt 1 of ${LANDING_PASS_MAX_ATTEMPTS}`);
    expect(prompt).not.toContain("was reset to");
  });

  it("lists a chunk's root and members", () => {
    const prompt = buildLandingPassPrompt({
      ...base,
      opening: { kind: "unit", label: "chunk #40", branch: "refs/remotes/origin/sandbar/chunk-40-x", preMergeSha: "pre" },
      issues: [40, 41, 42],
    });
    expect(prompt).toContain("# Landing pass: chunk #40");
    for (const n of [40, 41, 42]) {
      expect(prompt).toContain(`- \`gh issue view ${n} --repo acme/app --json title,body\``);
    }
  });

  it("lists no issue for a janitor branch", () => {
    const prompt = buildLandingPassPrompt({
      ...base,
      opening: { kind: "unit", label: "janitor tidy", branch: "refs/remotes/origin/sandbar/janitor-tidy", preMergeSha: "pre" },
      issues: [],
    });
    expect(prompt).toContain("# Landing pass: janitor tidy");
    expect(prompt).not.toContain("gh issue view");
  });

  it("opens a push race's pass on origin's new commits and the whole landing", () => {
    const prompt = buildLandingPassPrompt({
      ...base,
      opening: { kind: "sync", labels: ["chunk #40", "#12"], oldTip: "old", newTip: "new" },
      issues: [40, 12],
    });
    expect(prompt).toContain("This cycle landed chunk #40, #12 onto `main`");
    expect(prompt).toContain("`old..new` is what it added");
    expect(prompt).toContain("`git diff new HEAD`");
    expect(prompt).not.toContain("has just been merged");
  });

  it("names why the previous attempt was reset", () => {
    expect(buildLandingPassPrompt({ ...base, attempt: 2, retry: "a merge was left in progress" }))
      .toContain("Attempt 1 was reset to `merged`: a merge was left in progress.");
  });

  it("keeps the fixed frame within 1.2k chars (#258)", () => {
    const empty = buildLandingPassPrompt({
      opening: { kind: "unit", label: "", branch: "", preMergeSha: "" },
      target: "",
      mergedSha: "",
      issues: [],
      repoSlug: "",
      instructions: "",
      attempt: 1,
      retry: null,
    });
    expect(empty.length).toBeLessThanOrEqual(1_200);
  });
});

describe("runLandingPass attempts", () => {
  const run = (over: Partial<ResolveAgentRun>): ResolveAgentRun => ({
    stdout: "",
    stderr: "",
    output: "",
    end: "exit",
    exitCode: 0,
    signal: null,
    durationMs: 1_000,
    container: "c",
    cause: { kind: "exit" },
    verdict: "answer",
    toolCalls: 0,
    ...over,
  }) as ResolveAgentRun;

  const setup = (runs: ResolveAgentRun[]) => {
    const prompts: string[] = [];
    const resets: string[] = [];
    const adapter: LandingPassAdapter = {
      async runLandingPassAgent(prompt) {
        prompts.push(prompt);
        const next = runs.shift();
        if (!next) throw new Error("no attempt scripted");
        return next;
      },
      async changedPaths() {
        return ["src/app/x.ts"];
      },
      async readFileAt() {
        return "instructions";
      },
      async commitShape() {
        return { mergeInProgress: false, dirtyPaths: [], descends: true, commits: [] };
      },
      async getHeadSha() {
        return "merged";
      },
      async resetHardSha(sha) {
        resets.push(sha);
      },
    };
    const go = () =>
      runLandingPass(
        {
          label: "#12",
          promptAt: "pre",
          changed: { from: "pre", to: "HEAD" },
          prompt: {
            opening: { kind: "unit", label: "#12", branch: "b", preMergeSha: "pre" },
            target: "main",
            issues: [12],
            repoSlug: "acme/app",
          },
        },
        adapter,
        { settings: { prompt: { text: "t" }, paths: null }, log: async () => {} },
      );
    return { go, prompts, resets };
  };

  it("spends an attempt killed at the timeout without a signal, and runs the next", async () => {
    const { go, prompts, resets } = setup([
      run({ end: "timeout", exitCode: null, output: "still looking" }),
      run({ output: "<promise>DONE</promise>" }),
    ]);

    expect(await go()).toEqual({ kind: "done", commits: 0 });
    expect(resets).toEqual(["merged"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("10-minute timeout");
  });

  it("propagates a closed quota and spends no second attempt", async () => {
    const { go, prompts } = setup([
      run({
        verdict: "quota",
        rateLimit: { window: "five_hour" } as ResolveAgentRun["rateLimit"],
      }),
    ]);

    await expect(go()).rejects.toBeInstanceOf(AgentQuotaError);
    expect(prompts).toHaveLength(1);
  });

  it("propagates a refused credential and spends no second attempt", async () => {
    const { go, prompts } = setup([run({ verdict: "credential", detail: "expired" })]);

    await expect(go()).rejects.toBeInstanceOf(AgentCredentialError);
    expect(prompts).toHaveLength(1);
  });
});
