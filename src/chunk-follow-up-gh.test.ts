// Real-adapter coverage: path ownership depends on matching each durable
// member ref to its merge, and every forge call must name its repository.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LandedChunk } from "./chunks.js";
import { followUpMarker, realAdapter, routeChunkReviewFollowUps } from "./chunk-follow-up.js";

const CHUNK: LandedChunk = {
  root: 42, branch: "sandbar/chunk-42-first", title: "First",
  members: [{ number: 42, title: "First" }, { number: 44, title: "Second" }],
  closeOrder: [{ number: 44, title: "Second" }, { number: 42, title: "First" }],
  rework: [], tips: [{ number: 44, title: "Second" }],
};
const graphql = JSON.stringify({ data: { repository: { pullRequests: { nodes: [{
  number: 7, url: "https://github.com/acme/app/pull/7", comments: { nodes: [] },
  reviews: { nodes: [{ id: "PRR_a", url: "review", body: "", author: { login: "alice" } }] },
  reviewThreads: { nodes: [
    { isResolved: false, path: "src/first.ts", comments: { nodes: [{ body: "fix first", url: "thread-1", author: { login: "alice" }, pullRequestReview: { id: "PRR_a" } }] } },
    { isResolved: false, path: "src/second.ts", comments: { nodes: [{ body: "fix second", url: "thread-2", author: { login: "alice" }, pullRequestReview: { id: "PRR_a" } }] } },
  ] },
}] } } } });

describe("the chunk-review scan's real adapter", () => {
  let bin: string;
  let log: string;
  let oldPath: string | undefined;

  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "sandbar-followup-"));
    log = join(bin, "argv.log");
    await writeFile(log, "");
    oldPath = process.env["PATH"];
    process.env["SANDBAR_TEST_GRAPHQL"] = graphql;
    await writeFile(join(bin, "gh"), [
      "#!/bin/sh", `log='${log}'`,
      `for a in "$@"; do printf '%s\\0' "$a" >> "$log"; done`, `printf '\\001' >> "$log"`,
      `case "$1 $2" in`, ` "api graphql") printf '%s' "$SANDBAR_TEST_GRAPHQL" ;;`,
      ` "issue view") printf '{"number":%s,"title":"Issue %s","body":"body %s","labels":[{"name":"ready-for-agent"}]}' "$3" "$3" "$3" ;;`,
      "esac",
    ].join("\n") + "\n", { mode: 0o755 });
    await writeFile(join(bin, "git"), [
      "#!/bin/sh", `log='${log}'`,
      `for a in "$@"; do printf '%s\\0' "$a" >> "$log"; done`, `printf '\\001' >> "$log"`,
      `case "$1" in`, ` rev-list) printf 'merge44 base44 sha44\\nmerge42 base42 sha42\\n' ;;`,
      ` rev-parse) printf 'sha42\\nsha44\\n' ;;`,
      ` diff) case "$4" in merge42) printf 'src/first.ts\\n' ;; merge44) printf 'src/second.ts\\n' ;; esac ;;`,
      "esac",
    ].join("\n") + "\n", { mode: 0o755 });
    process.env["PATH"] = `${bin}:${oldPath ?? ""}`;
  });

  afterEach(async () => {
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
    delete process.env["SANDBAR_TEST_GRAPHQL"];
    await rm(bin, { recursive: true, force: true });
  });

  const calls = async (): Promise<string[][]> => (await readFile(log, "utf8"))
    .split("\u0001").slice(0, -1).map((record) => record.split("\0").slice(0, -1));

  it("matches both member refs to their merges and passes complete argv", async () => {
    const result = await routeChunkReviewFollowUps({ chunks: [CHUNK], adapter: realAdapter({
      repo: { owner: "acme", name: "app" }, repoDir: bin, sourceBranch: "main",
    }) });
    expect(result).toEqual([
      { number: 42, title: "Issue 42", body: "body 42", labels: ["ready-for-agent"] },
      { number: 44, title: "Issue 44", body: "body 44", labels: ["ready-for-agent"] },
    ]);
    const recorded = await calls();
    expect(recorded.find((call) => call[0] === "api")).toEqual([
      "api", "graphql", "-f", "owner=acme", "-f", "repo=app", "-f",
      `head=${CHUNK.branch}`, "-f", "base=main", "-f", expect.stringMatching(/^query=query\(/),
    ]);
    const gitCalls = recorded.filter((call) => ["rev-list", "rev-parse", "diff"].includes(call[0] ?? ""));
    expect(gitCalls).toEqual(expect.arrayContaining([
      ["rev-list", "--parents", "--first-parent", "--merges", `refs/remotes/origin/${CHUNK.branch}`],
      ["rev-parse", "refs/remotes/origin/sandbar/member-42", "refs/remotes/origin/sandbar/member-44"],
      ["diff", "--name-only", "base42", "merge42"],
      ["diff", "--name-only", "base44", "merge44"],
    ]));
    expect(gitCalls).toHaveLength(4);
    for (const number of [42, 44]) {
      const comment = recorded.find((call) => call[0] === "issue" && call[1] === "comment" && call[2] === String(number));
      expect(comment).toEqual(["issue", "comment", String(number), "--repo", "acme/app", "--body", expect.any(String)]);
      expect(comment?.[6]).toContain(number === 42 ? "src/first.ts" : "src/second.ts");
      expect(comment?.[6]).not.toContain(number === 42 ? "src/second.ts" : "src/first.ts");
      expect(recorded).toContainEqual(["issue", "edit", String(number), "--repo", "acme/app", "--add-label", "ready-for-agent"]);
      expect(recorded).toContainEqual(["issue", "view", String(number), "--repo", "acme/app", "--json", "number,title,body,labels"]);
    }
    const ledger = recorded.find((call) => call[0] === "pr" && call[1] === "comment");
    expect(ledger).toEqual(["pr", "comment", "7", "--repo", "acme/app", "--body", expect.any(String)]);
    expect(ledger?.[6]).toContain(followUpMarker("PRR_a"));
    expect(ledger?.[6]).toContain("#42 and #44");
    expect(recorded.some((call) => call[0] === "issue" && call[1] === "create")).toBe(false);
  });
});
