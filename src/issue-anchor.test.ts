import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHUNK_LAND_ABANDONED_PR_COMMENT,
} from "./chunk-land.js";
import {
  NEEDS_HUMAN_COMMENT_TEMPLATE,
  NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE,
  NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE,
  NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE,
  NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE,
  PUSH_REFUSED_COMMENT_TEMPLATE,
  REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE,
} from "./finalize.js";
import {
  CONDENSE_CONTRACT_VERSION,
  type CondenseAnswer,
  condenseKey,
  dropSandbarTraces,
  fetchIssueAnchor,
  parseCondenseAnswer,
  readCondenseCache,
  renderCondenserInput,
  renderIssueText,
  writeCondenseCache,
  type IssueJson,
} from "./issue-anchor.js";
import { buildChunkRefreshFailedComment } from "./merger.js";

describe("renderIssueText", () => {
  it("renders id, title, and body for a comment-less issue", () => {
    const text = renderIssueText("352", {
      title: "Freshness: mental-model curve",
      body: "## Why\n\nThe curve is wrong.\n",
      comments: [],
    });
    expect(text).toContain("Issue #352: Freshness: mental-model curve");
    expect(text).toContain("The curve is wrong.");
    expect(text).not.toContain("## Comments");
  });

  // The regression this module exists for: `gh issue view --comments` piped
  // prints only the comment thread, so a zero-comment issue yielded an empty
  // anchor. The body must always be present in the rendered text.
  it("never renders empty output, even for an empty issue object", () => {
    const text = renderIssueText("7", {});
    expect(text).toContain("Issue #7: (no title)");
    expect(text).toContain("(no description)");
  });

  it("renders the comment thread with author and timestamp", () => {
    const issue: IssueJson = {
      title: "t",
      body: "b",
      comments: [
        {
          author: { login: "alice" },
          createdAt: "2026-06-11T12:46:13Z",
          body: "first comment",
        },
        { body: "anonymous comment" },
      ],
    };
    const text = renderIssueText("9", issue);
    expect(text).toContain("## Comments");
    expect(text).toContain("### alice — 2026-06-11T12:46:13Z");
    expect(text).toContain("first comment");
    expect(text).toContain("### (unknown)");
    expect(text).toContain("anonymous comment");
  });

  it.each([
    {
      name: "an exact prefix",
      body: "**Sandbar:** agent question",
      heading: "### Sandbar (orchestrator, not a human) — 2026-06-11T12:46:13Z",
    },
    {
      name: "a prefix after leading whitespace",
      body: " \n **Sandbar:** agent question",
      heading: "### Sandbar (orchestrator, not a human) — 2026-06-11T12:46:13Z",
    },
    {
      name: "an ordinary human comment",
      body: "human answer",
      heading: "### operator — 2026-06-11T12:46:13Z",
    },
    {
      name: "a quoted sandbar comment",
      body: "> **Sandbar:** agent question\n\nhuman answer",
      heading: "### operator — 2026-06-11T12:46:13Z",
    },
    {
      name: "an inline sandbar mention",
      body: "I am replying to **Sandbar:** with an answer",
      heading: "### operator — 2026-06-11T12:46:13Z",
    },
  ])("attributes $name from the trimmed body's strict prefix", ({ body, heading }) => {
    const text = renderIssueText("9", {
      comments: [
        {
          author: { login: "operator" },
          createdAt: "2026-06-11T12:46:13Z",
          body,
        },
      ],
    });

    expect(text).toContain(heading);
    expect(text).toContain(body.trim());
  });

  it("keeps body before comments (spec first, discussion after)", () => {
    const text = renderIssueText("9", {
      title: "t",
      body: "THE-SPEC",
      comments: [{ body: "THE-COMMENT" }],
    });
    expect(text.indexOf("THE-SPEC")).toBeLessThan(text.indexOf("THE-COMMENT"));
  });
});

const TRACE = "SENTINEL-TRACE";
const PROSE = "SENTINEL-PROSE";
const BRANCH = "sandbar/issue-9-t";

// Every comment template that carries a trace or quoted reviewer prose, called
// with sentinels in those slots.
const templated: readonly { readonly name: string; readonly body: string }[] = [
  {
    name: "needs-human (gate red, with an earlier report)",
    body: NEEDS_HUMAN_COMMENT_TEMPLATE(BRANCH, "tests", 3, TRACE, PROSE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "needs-human (no signal)",
    body: NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE(BRANCH, 3, TRACE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "needs-human (uncommittable)",
    body: NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE(BRANCH, 2, TRACE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "needs-human (off branch)",
    body: NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE(
      BRANCH,
      2,
      TRACE,
      { branch: BRANCH, headRef: null, headSha: "abc", branchSha: "def" },
      { kind: "removed" },
      "agent-stuck",
      "ready-for-agent",
    ),
  },
  {
    name: "needs-human (reviewer harness, with an earlier report)",
    body: NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE(BRANCH, TRACE, PROSE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "review budget exhausted",
    body: REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(BRANCH, 2, PROSE, "agent-stuck", "ready-for-agent"),
  },
  {
    name: "push refused",
    body: PUSH_REFUSED_COMMENT_TEMPLATE({
      branch: BRANCH,
      reasons: [TRACE],
      recovery: { tipSha: "abc", ref: `refs/heads/${BRANCH}`, repoDir: "/cache" },
      stuckLabel: "agent-stuck",
      readyLabel: "ready-for-agent",
    }),
  },
  {
    name: "chunk refresh failed (gate red)",
    body: buildChunkRefreshFailedComment({
      chunkBranch: "sandbar/chunk-9",
      sourceBranch: "main",
      outcome: {
        kind: "abandon",
        mode: "gate-red",
        reason: "r",
        silent: false,
        attempts: [],
        conflictPaths: [],
        gateTrace: TRACE,
        durationMs: 0,
      },
      stuckLabel: "agent-stuck",
    }),
  },
  {
    name: "chunk land abandoned",
    body: CHUNK_LAND_ABANDONED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-9",
      sourceBranch: "main",
      mode: "conflict",
      reason: "r",
      attempts: [],
      conflictPaths: [TRACE],
    }),
  },
];

// Comments posted before the fences existed, one per lead-in line finalize.ts
// has used for quoted reviewer prose.
const legacy = (leadIn: string, tail: string): string =>
  `**Sandbar:** stopped.\n\n${leadIn}\n\n${PROSE}\n\n- more ${PROSE}\n\n${tail}`;
const DETAILS = `<details><summary>Gate trace</summary>\n\n\`\`\`\n${TRACE}\n\`\`\`\n\n</details>`;
const ACTION = "Action: use `b`; push a fix, then drop `agent-stuck` and re-apply `ready-for-agent`.";
const legacyFixtures = [
  "Latest quality review from the red round:",
  "Latest correctness review (an earlier round):",
  "Latest quality reviewer report:",
  "Latest correctness reviewer report:",
  "Latest verifier report:",
  "Latest verifier report (an earlier round):",
  "Earlier-round reviewer report (not a verdict on the current commits):",
  "Read-only quality reviewer output:",
].flatMap((leadIn) => [
  { name: `legacy "${leadIn}" before a trace`, body: legacy(leadIn, `${DETAILS}\n\n${ACTION}`) },
  { name: `legacy "${leadIn}" before the action`, body: legacy(leadIn, ACTION) },
]);

describe("dropSandbarTraces", () => {
  it.each([...templated, ...legacyFixtures])(
    "drops every trace and quote from $name, keeping the stop and action lines",
    ({ body }) => {
      const dropped = dropSandbarTraces(body);
      expect(dropped).not.toContain(TRACE);
      expect(dropped).not.toContain(PROSE);
      expect(dropped.split("\n")[0]).toBe(body.split("\n")[0]);
      const action = body.split("\n").find((l) => l.startsWith("Action:"));
      expect(dropped.split("\n")).toContain(action);
    },
  );

  it("replaces a block and a quote with one stub each", () => {
    const dropped = dropSandbarTraces(
      NEEDS_HUMAN_COMMENT_TEMPLATE(BRANCH, "tests", 3, TRACE, PROSE, "agent-stuck", "ready-for-agent"),
    );
    expect(dropped).toBe(
      "**Sandbar:** stopped after 3 consecutive attempts without a green gate-1; " +
        "latest failing step: `tests`.\n\n" +
        "_(quoted review omitted.)_\n\n" +
        "_(Gate trace omitted.)_\n\n" +
        `Action: use \`${BRANCH}\`; push a fix, then drop \`agent-stuck\` and re-apply \`ready-for-agent\`.`,
    );
  });

  it("cuts a legacy quote that runs to the end of the comment", () => {
    expect(dropSandbarTraces(`**Sandbar:** stopped.\n\nLatest verifier report:\n\n${PROSE}`)).toBe(
      "**Sandbar:** stopped.\n\n_(quoted review omitted.)_",
    );
  });

  it.each([
    { name: "a plain human comment", body: `Latest verifier report:\n\n${PROSE}` },
    { name: "a human comment quoting sandbar mid-text", body: `> **Sandbar:** stopped.\n\n${DETAILS}` },
    { name: "a human comment with its own details", body: `My notes:\n\n${DETAILS}\n\nAction: none` },
  ])("leaves $name byte-identical", ({ body }) => {
    expect(dropSandbarTraces(body)).toBe(body);
  });

  it("leaves a lead-in that does not start a paragraph in place", () => {
    const body = `**Sandbar:** stopped.\nLatest verifier report:\n\n${PROSE}`;
    expect(dropSandbarTraces(body)).toBe(body);
  });
});

describe("renderIssueText — sandbar traces", () => {
  it("drops traces from sandbar comments only, never from the body", () => {
    const text = renderIssueText("9", {
      title: "t",
      body: `Spec.\n\n${DETAILS}`,
      comments: [
        { author: { login: "operator" }, body: `Human.\n\n${DETAILS}` },
        {
          author: { login: "operator" },
          body: NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE(BRANCH, 3, "BOT-TRACE", "agent-stuck", "ready-for-agent"),
        },
      ],
    });
    expect(text.split(TRACE)).toHaveLength(3);
    expect(text).not.toContain("BOT-TRACE");
    expect(text).toContain("_(Attempt summary omitted.)_");
    expect(text).toContain("### Sandbar (orchestrator, not a human)");
  });
});

// Four comments: a proposal C1 that C3 overrules, a question C2 that C3
// answers, and the accepted decision C3 and the latest word C4, both kept.
const thread: IssueJson = {
  title: "Pick a store",
  body: "## Outcome\n\nPersist the cache.",
  comments: [
    { author: { login: "alice" }, createdAt: "2026-01-01T00:00:00Z", body: "Option A: sqlite." },
    { author: { login: "bob" }, createdAt: "2026-01-02T00:00:00Z", body: "Which directory?" },
    {
      author: { login: "alice" },
      createdAt: "2026-01-03T00:00:00Z",
      body: "Decision: option B, a JSON file under the workdir.\n\n  Indented line kept.",
    },
    { author: { login: "carol" }, createdAt: "2026-01-04T00:00:00Z", body: "Sounds good." },
  ],
};

const KEEP = { kind: "keep" } as const;
const condensedAnswer: CondenseAnswer = [
  { kind: "drop", by: 3, reason: "overruled: option B chosen" },
  { kind: "drop", by: 3, reason: null },
  KEEP,
  KEEP,
];

describe("parseCondenseAnswer", () => {
  const block = (lines: string) => `Thinking.\n<condense>\n${lines}\n</condense>`;

  it("reads one decision per comment", () => {
    expect(parseCondenseAnswer(
      block("C1 DROP C3 overruled: option B chosen\nC2 DROP C3\nC3 KEEP\nC4 KEEP"),
      4,
    )).toEqual({ kind: "valid", answer: condensedAnswer });
  });

  it("takes the last block, so a quoted opener before it does not count", () => {
    const stdout = `I will answer in a <condense> block.\n${block("C1 KEEP\nC2 KEEP")}`;
    expect(parseCondenseAnswer(stdout, 2)).toEqual({ kind: "valid", answer: [KEEP, KEEP] });
  });

  it("truncates an over-long reason and collapses its whitespace", () => {
    const parsed = parseCondenseAnswer(block(`C1 DROP C2 ${"x".repeat(119)}   y ${"z".repeat(40)}\nC2 KEEP`), 2);
    expect(parsed).toEqual({
      kind: "valid",
      answer: [{ kind: "drop", by: 2, reason: `${"x".repeat(119)} …` }, KEEP],
    });
  });

  it.each([
    { name: "no block", stdout: "C1 KEEP", reason: "no <condense> block" },
    { name: "a missing id", stdout: block("C1 KEEP"), reason: "C2 is not answered" },
    { name: "a duplicate id", stdout: block("C1 KEEP\nC1 KEEP\nC2 KEEP"), reason: "C1 is answered twice" },
    { name: "an id past the thread", stdout: block("C1 KEEP\nC2 KEEP\nC3 KEEP"), reason: "C3 is not a comment" },
    {
      name: "a drop for an earlier comment",
      stdout: block("C1 KEEP\nC2 DROP C1"),
      reason: "C2 is dropped for C1, which is not a later comment",
    },
    {
      name: "a drop for itself",
      stdout: block("C1 DROP C1\nC2 KEEP"),
      reason: "C1 is dropped for C1, which is not a later comment",
    },
    {
      name: "a drop past the thread",
      stdout: block("C1 DROP C3\nC2 KEEP"),
      reason: "C1 is dropped for C3, which is not a later comment",
    },
    { name: "prose between lines", stdout: block("C1 KEEP\nso then\nC2 KEEP"), reason: "unreadable line: so then" },
    { name: "the newest comment dropped", stdout: block("C1 KEEP\nC2 DROP"), reason: "unreadable line: C2 DROP" },
  ])("refuses $name", ({ stdout, reason }) => {
    expect(parseCondenseAnswer(stdout, 2)).toEqual({ kind: "invalid", reason });
  });
});

describe("renderIssueText — condensed", () => {
  const condensed = renderIssueText("9", thread, { answer: condensedAnswer, repo: { owner: "o", name: "r" } });

  it("keeps every kept comment byte-equal and stubs each drop", () => {
    const plain = renderIssueText("9", thread);
    for (const c of thread.comments!.slice(2)) expect(condensed).toContain(c.body!);
    expect(condensed).not.toContain("Option A: sqlite.");
    expect(condensed).not.toContain("Which directory?");
    expect(condensed).toBe([
      "Issue #9: Pick a store",
      "",
      "## Outcome\n\nPersist the cache.",
      "",
      "## Comments (condensed)",
      "",
      "2 of 4 comments were dropped as superseded by later ones; every other comment " +
        "is verbatim. Full thread: `gh issue view 9 --repo o/r --comments`.",
      "",
      "_Dropped: alice, 2026-01-01T00:00:00Z, superseded by alice, 2026-01-03T00:00:00Z: overruled: option B chosen_",
      "_Dropped: bob, 2026-01-02T00:00:00Z, superseded by alice, 2026-01-03T00:00:00Z_",
      plain.slice(plain.indexOf("\n\n### alice — 2026-01-03")).slice(1),
    ].join("\n"));
  });

  it("renders an answer that drops nothing as the plain thread", () => {
    expect(renderIssueText("9", thread, { answer: [KEEP, KEEP, KEEP, KEEP], repo: { owner: "o", name: "r" } }))
      .toBe(renderIssueText("9", thread));
  });

  it("separates drops that a kept comment splits", () => {
    const text = renderIssueText("9", thread, {
      answer: [{ kind: "drop", by: 2, reason: null }, KEEP, { kind: "drop", by: 4, reason: null }, KEEP],
      repo: { owner: "o", name: "r" },
    });
    expect(text).toContain("Which directory?\n\n_Dropped: alice, 2026-01-03T00:00:00Z");
    expect(text).toContain("superseded by bob, 2026-01-02T00:00:00Z_\n\n### bob");
  });

  it("refuses an answer about another thread", () => {
    expect(() => renderIssueText("9", thread, {
      answer: [{ kind: "drop", by: 2, reason: null }, KEEP],
      repo: { owner: "o", name: "r" },
    })).toThrow("a condenser answer for 2 comments rendered over 4");
  });
});

describe("condenseKey", () => {
  const key = condenseKey(thread);

  it("ignores the title and anything else outside the body and thread", () => {
    expect(condenseKey({ ...thread, title: "Renamed", labels: ["agent-stuck"] } as IssueJson)).toBe(key);
  });

  it("changes when any comment, the body or the thread length does", () => {
    const comments = thread.comments!;
    expect(condenseKey({ ...thread, body: "Changed." })).not.toBe(key);
    expect(condenseKey({ ...thread, comments: comments.slice(0, 3) })).not.toBe(key);
    expect(condenseKey({
      ...thread,
      comments: [comments[0]!, { ...comments[1]!, body: "Which file?" }, ...comments.slice(2)],
    })).not.toBe(key);
  });

  it("ignores a trace only sandbar's own comment carried", () => {
    const bot = (trace: string): IssueJson => ({
      ...thread,
      comments: [{ body: `**Sandbar:** stopped.\n\n<details><summary>Gate trace</summary>\n\n${trace}\n</details>` }],
    });
    expect(condenseKey(bot("one"))).toBe(condenseKey(bot("two")));
  });
});

describe("renderCondenserInput", () => {
  it("numbers each comment as the answer names it, after the body", () => {
    expect(renderCondenserInput("9", thread)).toBe([
      "Issue #9: Pick a store",
      "",
      "## Issue body (context only, always kept)",
      "",
      "## Outcome\n\nPersist the cache.",
      "",
      "### C1 — alice — 2026-01-01T00:00:00Z",
      "",
      "Option A: sqlite.",
      "",
      "### C2 — bob — 2026-01-02T00:00:00Z",
      "",
      "Which directory?",
      "",
      "### C3 — alice — 2026-01-03T00:00:00Z",
      "",
      thread.comments![2]!.body,
      "",
      "### C4 — carol — 2026-01-04T00:00:00Z",
      "",
      "Sounds good.",
    ].join("\n"));
  });
});

describe("the condense cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "anchor-cache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const key = condenseKey(thread);
  const entry = { key, answer: condensedAnswer, provider: "claude", model: "sonnet" };

  it("writes an entry a later read finds, leaving no temporary file", async () => {
    const cacheDir = join(dir, "anchor-cache");
    await writeCondenseCache(cacheDir, "9", entry);
    expect(await readdir(cacheDir)).toEqual(["9.json"]);
    expect(JSON.parse(await readFile(join(cacheDir, "9.json"), "utf8"))).toMatchObject({
      v: CONDENSE_CONTRACT_VERSION,
      ...entry,
    });
    expect(await readCondenseCache(cacheDir, "9", key, 4)).toEqual({ kind: "hit", answer: condensedAnswer });
  });

  it("misses silently with no entry, or one about another thread", async () => {
    expect(await readCondenseCache(dir, "9", key, 4)).toEqual({ kind: "miss", problem: null });
    await writeCondenseCache(dir, "9", { ...entry, key: "other" });
    expect(await readCondenseCache(dir, "9", key, 4)).toEqual({ kind: "miss", problem: null });
  });

  it.each([
    { name: "not JSON", content: "{", problem: "is not JSON" },
    { name: "without an answer", content: JSON.stringify({ v: CONDENSE_CONTRACT_VERSION, key }), problem: "holds no condenser answer" },
    {
      name: "with a malformed decision",
      content: JSON.stringify({ v: CONDENSE_CONTRACT_VERSION, key, answer: [{ kind: "drop", by: "3" }] }),
      problem: "holds no condenser answer",
    },
    {
      name: "with an answer that does not fit the thread",
      content: JSON.stringify({ v: CONDENSE_CONTRACT_VERSION, key, answer: [KEEP] }),
      problem: "holds an invalid answer: 1 decisions for 4 comments",
    },
  ])("misses with a problem for an entry $name", async ({ content, problem }) => {
    await writeFile(join(dir, "9.json"), content);
    expect(await readCondenseCache(dir, "9", key, 4)).toEqual({
      kind: "miss",
      problem: `anchor cache ${join(dir, "9.json")} ${problem}`,
    });
  });

  it("misses with a problem when the entry cannot be read", async () => {
    await mkdir(join(dir, "9.json"));
    const read = await readCondenseCache(dir, "9", key, 4);
    expect(read.kind).toBe("miss");
    expect(read.kind === "miss" && read.problem).toMatch(/9\.json is unreadable: EISDIR/);
  });
});

describe("fetchIssueAnchor", () => {
  let dir: string;
  let originalPath: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "issue-anchor-"));
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "issue.json"), JSON.stringify(thread));
    // Prints the fixture whatever it is asked: which repository the fetch
    // names is prompt-cwd.test.ts's subject.
    await writeFile(join(dir, "bin", "gh"), `#!/bin/sh\ncat "${join(dir, "issue.json")}"\n`);
    await chmod(join(dir, "bin", "gh"), 0o755);
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${join(dir, "bin")}:${originalPath ?? ""}`;
  });
  afterEach(async () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(dir, { recursive: true, force: true });
  });

  const repo = { owner: "o", name: "r" };

  it("renders the uncondensed thread until the cache answers it, then the condensed one", async () => {
    const cacheDir = join(dir, "anchor-cache");
    const plain = renderIssueText("9", thread);
    const before = await fetchIssueAnchor("9", repo, cacheDir);
    expect(before).toEqual({
      text: plain,
      json: thread,
      key: condenseKey(thread),
      cache: { kind: "miss", problem: null },
      rawChars: plain.length,
      tracedChars: plain.length,
    });

    await writeCondenseCache(cacheDir, "9", {
      key: before.key, answer: condensedAnswer, provider: "claude", model: "sonnet",
    });
    const after = await fetchIssueAnchor("9", repo, cacheDir);
    expect(after.cache).toEqual({ kind: "hit", answer: condensedAnswer });
    expect(after.text).toBe(renderIssueText("9", thread, { answer: condensedAnswer, repo }));
    expect(after.tracedChars).toBe(plain.length);
  });

  it("measures the anchor before and after sandbar's traces are dropped", async () => {
    const bot = "**Sandbar:** stopped.\n\n<details><summary>Gate trace</summary>\n\n" +
      "x".repeat(500) + "\n</details>";
    const traced: IssueJson = { ...thread, comments: [{ body: bot }] };
    await writeFile(join(dir, "issue.json"), JSON.stringify(traced));
    const anchor = await fetchIssueAnchor("9", repo, join(dir, "anchor-cache"));
    expect(anchor.tracedChars).toBe(renderIssueText("9", traced).length);
    expect(anchor.rawChars).toBe(anchor.tracedChars + bot.length - dropSandbarTraces(bot).length);
    expect(anchor.rawChars - anchor.tracedChars).toBeGreaterThan(450);
  });
});
