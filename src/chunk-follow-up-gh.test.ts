import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LandedChunk } from "./chunks.js";
import { routeChunkReviewFollowUps, followUpMarker, realAdapter } from "./chunk-follow-up.js";

const CHUNK: LandedChunk = { root: 42, branch: "sandbar/chunk-42-first", title: "First", members: [{ number: 42, title: "First" }], closeOrder: [{ number: 42, title: "First" }], rework: [], tips: [{ number: 42, title: "First" }] };
const graphql = JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ number: 7, url: "pr", comments: { nodes: [] }, reviews: { nodes: [{ id: "PRR_a", url: "review", body: "", author: { login: "alice" } }] }, reviewThreads: { nodes: [{ isResolved: false, path: "src/a.ts", comments: { nodes: [{ body: "fix it", url: "thread", author: { login: "alice" }, pullRequestReview: { id: "PRR_a" } }] } }] } }] } } } });

describe("the chunk-review scan's real adapter", () => {
  let bin: string; let log: string; let oldPath: string | undefined;
  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "sandbar-followup-")); log = join(bin, "log"); await writeFile(log, ""); oldPath = process.env["PATH"];
    await writeFile(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\0' "$@" >> '${log}'; printf '\\001' >> '${log}'\ncase "$1 $2" in\n 'api graphql') printf '%s' '${graphql}' ;;\n 'issue view') printf '%s' '{"number":42,"title":"First","body":"body","labels":[{"name":"ready-for-agent"}]}' ;;\nesac\n`, { mode: 0o755 });
    await writeFile(join(bin, "git"), `#!/bin/sh\ncase "$1" in\n rev-list) if [ "$2" = '--first-parent' ]; then printf 'merge\\n'; else printf 'merge first member\\n'; fi ;;\n rev-parse) printf 'member\\n' ;;\n diff) printf 'src/a.ts\\n' ;;\nesac\n`, { mode: 0o755 });
    process.env["PATH"] = `${bin}:${oldPath ?? ""}`;
  });
  afterEach(async () => { if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath; await rm(bin, { recursive: true, force: true }); });
  const calls = async () => (await readFile(log, "utf8")).split("\u0001").slice(0, -1).map((r) => r.split("\0").slice(0, -1));

  it("comments on and labels the existing member, then records the PR ledger", async () => {
    const result = await routeChunkReviewFollowUps({ chunks: [CHUNK], adapter: realAdapter({ repo: { owner: "acme", name: "app" }, repoDir: bin, sourceBranch: "main" }) });
    expect(result).toEqual([{ number: 42, title: "First", body: "body", labels: ["ready-for-agent"] }]);
    const recorded = await calls();
    expect(recorded.some((a) => a.slice(0, 3).join(" ") === "issue comment 42")).toBe(true);
    expect(recorded.some((a) => a.slice(0, 3).join(" ") === "issue edit 42" && a.includes("--add-label"))).toBe(true);
    const ledger = recorded.find((a) => a.slice(0, 2).join(" ") === "pr comment");
    expect(ledger?.join(" ")).toContain(followUpMarker("PRR_a"));
    expect(ledger?.join(" ")).toContain("#42");
    expect(recorded.some((a) => a.slice(0, 2).join(" ") === "issue create")).toBe(false);
  });
});
