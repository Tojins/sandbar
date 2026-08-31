// #63 — the argv of the chunk-review scan's three `gh` calls, and the two
// behaviours that only the real adapter can be wrong about.
//
// Same reasoning as `gh-argv.test.ts` and `lanes-gh.test.ts`: these calls read
// a human's review, CREATE an issue and comment on their pull request, so
// "which repository" being wrong is an issue filed in the wrong place, and a
// fake adapter satisfies the contract whatever argv the real one builds. Two
// more things live here rather than in the pure tests because they are
// properties of the calls, not of the decisions: the issue number is parsed out
// of `gh issue create`'s echoed URL, and a failed ledger comment has to name
// the issue it just filed.
//
// Driven through a `gh` shim on PATH that records its own argv NUL-separated
// (the GraphQL query and an issue body both contain newlines and quotes, so a
// line-per-call log cannot hold them) and answers from env vars.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LandedChunk } from "./chunks.js";
import {
  fileChunkReviewFollowUps,
  followUpMarker,
  realAdapter,
} from "./chunk-follow-up.js";
import { SandbarError } from "./errors.js";

const REPO = { owner: "acme", name: "app" };

const CHUNK: LandedChunk = {
  root: 42,
  branch: "sandbar/chunk-42-first",
  tips: [{ number: 43, title: "Second" }],
};

// One open PR on the chunk branch, with one changes-requested review and one
// unresolved thread belonging to it.
const graphql = (comments: readonly string[] = []): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 7,
              url: "https://github.com/acme/app/pull/7",
              comments: { nodes: comments.map((body) => ({ body })) },
              reviews: {
                nodes: [
                  {
                    id: "PRR_kwabc",
                    url: "https://github.com/acme/app/pull/7#pullrequestreview-1",
                    body: "Two things.",
                    author: { login: "alice" },
                  },
                ],
              },
              reviewThreads: {
                nodes: [
                  {
                    isResolved: false,
                    path: "src/merger.ts",
                    comments: {
                      nodes: [
                        {
                          body: "This drops the error.",
                          url: "https://github.com/acme/app/pull/7#discussion_r1",
                          author: { login: "alice" },
                          pullRequestReview: { id: "PRR_kwabc" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });

const NO_PR = JSON.stringify({
  data: { repository: { pullRequests: { nodes: [] } } },
});

describe("the chunk-review scan's gh calls (#63)", () => {
  let shimBin: string;
  let argvLog: string;
  let originalPath: string | undefined;

  // Every recorded invocation, as argv arrays. Records are \x01-separated and
  // args NUL-separated, so a query or an issue body survives the round trip.
  const calls = async (): Promise<string[][]> => {
    const raw = await readFile(argvLog, "utf8");
    return raw
      .split("\u0001")
      .slice(0, -1)
      .map((rec) => rec.split("\0").slice(0, -1));
  };

  const callsTo = async (...head: string[]): Promise<string[][]> =>
    (await calls()).filter((argv) =>
      head.every((word, i) => argv[i] === word),
    );

  const flagOf = (argv: readonly string[], flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : argv[i + 1];
  };

  const set = (vars: Record<string, string>): void => {
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  };

  beforeEach(async () => {
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-followupgh-"));
    argvLog = join(shimBin, "argv.log");
    await writeFile(argvLog, "");
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        `log='${argvLog}'`,
        'for a in "$@"; do printf \'%s\\0\' "$a" >> "$log"; done',
        "printf '\\001' >> \"$log\"",
        'case "$1 $2" in',
        '  "api graphql") printf "%s" "$SANDBAR_TEST_GRAPHQL" ;;',
        '  "issue create")',
        '    [ -n "$SANDBAR_TEST_CREATE_FAIL" ] && exit 1',
        '    printf "%s\\n" "$SANDBAR_TEST_ISSUE_URL" ;;',
        '  "pr comment") [ -n "$SANDBAR_TEST_COMMENT_FAIL" ] && exit 1 ;;',
        "esac",
        "exit 0",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
    set({
      SANDBAR_TEST_GRAPHQL: graphql(),
      SANDBAR_TEST_ISSUE_URL: "https://github.com/acme/app/issues/99",
      SANDBAR_TEST_CREATE_FAIL: "",
      SANDBAR_TEST_COMMENT_FAIL: "",
    });
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    for (const k of [
      "SANDBAR_TEST_GRAPHQL",
      "SANDBAR_TEST_ISSUE_URL",
      "SANDBAR_TEST_CREATE_FAIL",
      "SANDBAR_TEST_COMMENT_FAIL",
    ]) {
      delete process.env[k];
    }
    await rm(shimBin, { recursive: true, force: true });
  });

  const scan = (chunks: readonly LandedChunk[] = [CHUNK]) =>
    fileChunkReviewFollowUps({
      chunks,
      adapter: realAdapter({ repo: REPO, sourceBranch: "main" }),
    });

  it("reads the reviews for the chunk branch, naming the repository", async () => {
    await scan();
    const [read] = await callsTo("api", "graphql");
    expect(read).toBeDefined();
    // `-f` and not `-F`: `-F` types its value, and a repo or a branch that
    // looks like a number would reach a `String!` variable as one.
    expect(read).toContain("-f");
    expect(read).not.toContain("-F");
    const params = (read ?? []).filter((a) => a.includes("="));
    expect(params).toContain("owner=acme");
    expect(params).toContain("repo=app");
    expect(params).toContain(`head=${CHUNK.branch}`);
    // The head-to-base PAIR, which is how `ensurePullRequest` finds the PR it
    // maintains: asking by head alone can read a different one.
    expect(params).toContain("base=main");
  });

  it("asks for the NEWEST page of the ledger, the reviews and the threads", async () => {
    // GitHub orders these connections ASCENDING by creation, so `first:` reads
    // the oldest page of each. On the ledger that is the difference between one
    // follow-up issue and one per cycle forever: entries are appended, so the
    // newest comments are the ones that say a review has already been
    // converted. On the other two it is a silent DROP — a review or a thread
    // too new to be inside the window is never filed and so never ledgered.
    await scan();
    const [read] = await callsTo("api", "graphql");
    const query = (read ?? []).find((a) => a.startsWith("query=")) ?? "";
    expect(query).toContain("comments(last:100)");
    expect(query).toContain("reviews(states:[CHANGES_REQUESTED],last:50)");
    expect(query).toContain("reviewThreads(last:100)");
    // The one exception, and it is the other way round on purpose: a thread
    // opens with the point being made, so its first comments are the prefix
    // worth quoting.
    expect(query).toContain("comments(first:50)");
  });

  it("files the issue in the named repository, on the queue label", async () => {
    await scan();
    const [create] = await callsTo("issue", "create");
    expect(flagOf(create ?? [], "--repo")).toBe("acme/app");
    expect(flagOf(create ?? [], "--label")).toBe("ready-for-agent");
    expect(flagOf(create ?? [], "--title")).toBe(
      "Chunk #42: address alice's review feedback",
    );
    // The `## Blocked by` section is what puts the issue in the chunk, so it
    // has to survive being handed to `gh` rather than only being built.
    expect(flagOf(create ?? [], "--body")).toContain("- #43");
  });

  it("records the review on the pull request, in the same repository", async () => {
    await scan();
    const [comment] = await callsTo("pr", "comment");
    expect(comment?.[2]).toBe("7");
    expect(flagOf(comment ?? [], "--repo")).toBe("acme/app");
    expect(flagOf(comment ?? [], "--body")).toContain(followUpMarker("PRR_kwabc"));
    expect(flagOf(comment ?? [], "--body")).toContain("#99");
  });

  it("returns the filed issue as a candidate, numbered from gh's own output", async () => {
    // The number is what the caller re-plans with; parsing it out of the
    // echoed URL is the one thing between `gh` and the next cycle's plan.
    const created = await scan();
    expect(created).toEqual([
      {
        number: 99,
        title: "Chunk #42: address alice's review feedback",
        body: expect.stringContaining("- #43") as unknown as string,
        labels: ["ready-for-agent"],
      },
    ]);
  });

  it("files nothing when the ledger already names the review", async () => {
    set({ SANDBAR_TEST_GRAPHQL: graphql([`filed #99 ${followUpMarker("PRR_kwabc")}`]) });
    expect(await scan()).toEqual([]);
    expect(await callsTo("issue", "create")).toEqual([]);
    expect(await callsTo("pr", "comment")).toEqual([]);
  });

  it("files nothing when the chunk branch has no open pull request", async () => {
    set({ SANDBAR_TEST_GRAPHQL: NO_PR });
    expect(await scan()).toEqual([]);
    expect(await callsTo("issue", "create")).toEqual([]);
  });

  it("calls nothing at all when no chunk has landed", async () => {
    expect(await scan([])).toEqual([]);
    expect(await calls()).toEqual([]);
  });

  it("fails loud, and says nothing was written, when the issue cannot be filed", async () => {
    set({ SANDBAR_TEST_CREATE_FAIL: "1" });
    await expect(scan()).rejects.toBeInstanceOf(SandbarError);
    await expect(scan()).rejects.toThrow(/next cycle files it/);
    expect(await callsTo("pr", "comment")).toEqual([]);
  });

  it("fails loud and names the issue when the ledger comment cannot be posted", async () => {
    // The compounding failure: an issue exists that the ledger does not know
    // about, so every later cycle would file another one. The message has to
    // carry both halves of the manual fix.
    set({ SANDBAR_TEST_COMMENT_FAIL: "1" });
    await expect(scan()).rejects.toThrow(/#99/);
    await expect(scan()).rejects.toThrow(
      new RegExp(followUpMarker("PRR_kwabc").replace(/[-!]/g, "\\$&")),
    );
  });

  it("fails loud when the reviews cannot be read at all", async () => {
    // Sandbar cannot tell whether a human is waiting, and the merge phase
    // would go on adding members to the branch they are waiting on.
    set({ SANDBAR_TEST_GRAPHQL: "not json" });
    await expect(scan()).rejects.toBeInstanceOf(SandbarError);
    await expect(scan()).rejects.toThrow(/Could not read the reviews/);
  });
});
