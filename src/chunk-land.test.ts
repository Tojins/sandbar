// #64 — the pure half of landing a reviewed chunk: which chunks a `land` label
// asks for, which ones landed without sandbar, and the wrap-up that closes one
// out. The wrap-up is adapter-driven and never throws, so what is asserted here
// is the ORDER of its writes and where its residue comes from.
import { describe, expect, it } from "vitest";

import {
  CHUNK_LANDED_PR_COMMENT,
  CHUNK_LANDED_UNNAMED_BANNER,
  CHUNK_RESIDUE_KEPT_BANNER,
  CHUNK_RESIDUE_RETIRED_BANNER,
  type ChunkWrapup,
  chunkResidue,
  CHUNK_LAND_ABANDONED_PR_COMMENT,
  CHUNK_LAND_DEFERRED_PR_COMMENT,
  CHUNK_MEMBER_CLOSED_COMMENT,
  type ChunkWrapupAdapter,
  LAND_LABEL,
  type PullRequestSummary,
  selectLandRequests,
  selectReconciliations,
  wrapUpLandedChunk,
} from "./chunk-land.js";
import { NEEDS_REVIEW_LABEL, type LandedChunk } from "./chunks.js";
import type { ResolveAttemptSummary } from "./resolve-loop.js";

// One entry of the resolve loop's journal (#67), as the abandoned-chunk comment
// receives it.
const resolveAttempt = (
  attempt: number,
  over: Partial<ResolveAttemptSummary> = {},
): ResolveAttemptSummary => ({
  attempt,
  end: "exit",
  exitCode: 0,
  signal: null,
  durationMs: 12_000,
  container: `sandbar-wdeadbeef-resolve-${attempt}-uuid`,
  stdoutBytes: 900,
  stderrBytes: 0,
  verdict: "still-conflicted",
  logPath: `.sandbar/logs/run-x/cycle-1/resolve-chunk-42-attempt-${attempt}.log`,
  ...over,
});

const chunk = (
  root: number,
  branch: string,
  members: readonly [number, string][],
  title = "root title",
): LandedChunk => ({
  root,
  branch,
  title,
  members: members.map(([number, t]) => ({ number, title: t })),
  // A chain, which is what `members` ascending reads as here: the deepest
  // member closes first and the root last. `chunks.ts` is where that order is
  // derived and where the argument for it lives; this file only has to carry
  // it through the selectors and act on it in the wrap-up.
  closeOrder: [...members].reverse().map(([number, t]) => ({ number, title: t })),
  // The selectors read the members, never the tips — that half of a
  // `LandedChunk` belongs to the review scan (#63).
  tips: [],
});

const pr = (
  number: number,
  headRefName: string,
  title = "pr title",
): PullRequestSummary => ({ number, headRefName, title });

describe("selectLandRequests (#64)", () => {
  it("matches a land-labelled PR to its derived chunk and takes its members", () => {
    const chunks = [
      chunk(42, "sandbar/chunk-42-alpha", [
        [42, "alpha"],
        [43, "beta"],
      ], "alpha"),
    ];
    expect(
      selectLandRequests([pr(9, "sandbar/chunk-42-alpha")], chunks),
    ).toEqual([
      {
        root: 42,
        branch: "sandbar/chunk-42-alpha",
        title: "alpha",
        members: [
          { number: 42, title: "alpha" },
          { number: 43, title: "beta" },
        ],
        // Carried through verbatim: the wrap-up closes in this order, and the
        // derivation is the only thing that can compute it (#64).
        closeOrder: [
          { number: 43, title: "beta" },
          { number: 42, title: "alpha" },
        ],
        pullRequest: 9,
      },
    ]);
  });

  it("keeps a chunk-branch PR the derivation does not know, with no members", () => {
    const [target] = selectLandRequests(
      [pr(9, "sandbar/chunk-42-alpha", "Sandbar chunk #42: alpha")],
      [],
    );
    expect(target).toEqual({
      root: 42,
      branch: "sandbar/chunk-42-alpha",
      title: "Sandbar chunk #42: alpha",
      members: [],
      closeOrder: [],
      pullRequest: 9,
    });
  });

  it("ignores a land label on a pull request that is not a chunk's", () => {
    expect(
      selectLandRequests(
        [pr(9, "feature/some-human-branch"), pr(10, "sandbar/issue-7-x")],
        [],
      ),
    ).toEqual([]);
  });

  it("takes the lowest-numbered PR when a head somehow has two, and sorts by root", () => {
    const targets = selectLandRequests(
      [
        pr(30, "sandbar/chunk-9-b"),
        pr(20, "sandbar/chunk-42-a"),
        pr(11, "sandbar/chunk-42-a"),
      ],
      [],
    );
    expect(targets.map((t) => [t.root, t.pullRequest])).toEqual([
      [9, 30],
      [42, 11],
    ]);
  });
});

describe("selectReconciliations (#64)", () => {
  it("pairs a landed branch with its chunk and its open pull request", () => {
    const targets = selectReconciliations(
      ["sandbar/chunk-42-alpha"],
      [chunk(42, "sandbar/chunk-42-alpha", [[42, "alpha"]], "alpha")],
      [pr(9, "sandbar/chunk-42-alpha")],
    );
    expect(targets).toEqual([
      {
        root: 42,
        branch: "sandbar/chunk-42-alpha",
        title: "alpha",
        members: [{ number: 42, title: "alpha" }],
        closeOrder: [{ number: 42, title: "alpha" }],
        pullRequest: 9,
      },
    ]);
  });

  it("reconciles a landed branch whose PR a human already closed", () => {
    const [target] = selectReconciliations(
      ["sandbar/chunk-42-alpha"],
      [chunk(42, "sandbar/chunk-42-alpha", [[42, "alpha"]], "alpha")],
      [],
    );
    expect(target?.pullRequest).toBe(0);
    expect(target?.members).toEqual([{ number: 42, title: "alpha" }]);
  });

  it("dedupes branches and drops anything that is not a chunk branch", () => {
    const targets = selectReconciliations(
      [
        "sandbar/chunk-42-alpha",
        "sandbar/chunk-42-alpha",
        "sandbar/issue-42-alpha",
      ],
      [],
      [],
    );
    expect(targets.map((t) => t.branch)).toEqual(["sandbar/chunk-42-alpha"]);
  });
});

// ---------------------------------------------------------------------------

type Recorded = { readonly op: string; readonly arg: string };

function makeWrapupAdapter(
  fail: Partial<Record<string, string>> = {},
): {
  adapter: ChunkWrapupAdapter;
  calls: Recorded[];
  // The bodies the wrap-up wrote, which is where the "what may this claim?"
  // assertions live: the templates are pure and tested directly, so what is
  // worth pinning here is which of them the wrap-up chose to send.
  bodies: string[];
} {
  const calls: Recorded[] = [];
  const bodies: string[] = [];
  const record = (op: string, arg: string): void => {
    calls.push({ op, arg });
    const err = fail[`${op}:${arg}`] ?? fail[op];
    if (err) throw new Error(err);
  };
  return {
    calls,
    bodies,
    adapter: {
      async closeIssue(n, comment) {
        // After `record`, which is what throws: a close that failed posted no
        // comment, so it must not leave one here either.
        record("closeIssue", String(n));
        bodies.push(comment);
      },
      async removeLabel(n, label) {
        record("removeLabel", `${n}:${label}`);
      },
      async commentOnPullRequest(p, body) {
        record("commentOnPullRequest", String(p));
        bodies.push(body);
      },
      async removePullRequestLabel(p, label) {
        record("removePullRequestLabel", `${p}:${label}`);
      },
      async closePullRequest(p) {
        record("closePullRequest", String(p));
      },
      async deleteChunkBranch(b) {
        record("deleteChunkBranch", b);
      },
    },
  };
}

// A chunk of two: #43's work is written on top of #42's, so #42 is the root
// the branch is named after and #43 closes FIRST.
const target = {
  root: 42,
  branch: "sandbar/chunk-42-alpha",
  title: "alpha",
  members: [
    { number: 42, title: "alpha" },
    { number: 43, title: "beta" },
  ],
  closeOrder: [
    { number: 43, title: "beta" },
    { number: 42, title: "alpha" },
  ],
  pullRequest: 9,
};

describe("wrapUpLandedChunk (#64)", () => {
  it("closes every member in dependency order, drops needs-review, closes the PR, deletes the branch", async () => {
    const { adapter, calls } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.residue).toEqual([]);
    // Ascending in the RESULT, which is a report, and dependents-first in the
    // calls, which are the acts: #43 closes before the root it is built on.
    expect(r.closed).toEqual([42, 43]);
    expect(r.branchDeleted).toBe(true);
    expect(calls.map((c) => `${c.op} ${c.arg}`)).toEqual([
      "closeIssue 43",
      `removeLabel 43:${NEEDS_REVIEW_LABEL}`,
      "closeIssue 42",
      `removeLabel 42:${NEEDS_REVIEW_LABEL}`,
      "commentOnPullRequest 9",
      `removePullRequestLabel 9:${LAND_LABEL}`,
      "closePullRequest 9",
      "deleteChunkBranch sandbar/chunk-42-alpha",
    ]);
  });

  it("stops at the first close it cannot make, and never closes the root behind it", async () => {
    // THE invariant of the whole wrap-up. The branch is kept so the next
    // cycle's reconciler retries it, and that reconciler finds it by NAME —
    // `sandbar/chunk-<root>-<slug>`, re-derived from the open issues. Closing
    // #42 here would take the root out of that graph, re-root the chunk under
    // #43 on a branch origin has never had, and leave the kept branch matching
    // nothing: deleted next cycle, with #43 open and no branch left to retry.
    const { adapter, calls } = makeWrapupAdapter({ "closeIssue:43": "gh boom" });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.closed).toEqual([]);
    expect(r.branchDeleted).toBe(false);
    expect(calls.filter((c) => c.op === "closeIssue").map((c) => c.arg)).toEqual([
      "43",
    ]);
    expect(calls.some((c) => c.op === "deleteChunkBranch")).toBe(false);
    // The unclosed member keeps its display cue; wrap-up changes labels only
    // after the corresponding close succeeds.
    expect(calls.some((c) => c.op === "removeLabel")).toBe(false);
    expect(r.residue.join("\n")).toContain("#43 could not be closed");
    expect(r.residue.join("\n")).toContain("kept on origin");
  });

  it("leaves everything behind a failed close untouched, the root included", async () => {
    // A chain: #42 ← #43 ← #44, so the order is #44, #43, #42. #44 closes,
    // #43 will not, and #42 is never asked — which is what the ORDER buys
    // beyond simply holding the root back. Closing #42 now would re-root the
    // chunk under #43 and rename its branch; the branch on origin is the one
    // #44's commits are on, and it has to keep matching.
    const chain = {
      ...target,
      members: [...target.members, { number: 44, title: "gamma" }],
      closeOrder: [
        { number: 44, title: "gamma" },
        { number: 43, title: "beta" },
        { number: 42, title: "alpha" },
      ],
    };
    const { adapter, calls } = makeWrapupAdapter({ "closeIssue:43": "gh boom" });
    const r = await wrapUpLandedChunk(chain, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });

    expect(r.closed).toEqual([44]);
    expect(calls.filter((c) => c.op === "closeIssue").map((c) => c.arg)).toEqual([
      "44",
      "43",
    ]);
    expect(r.branchDeleted).toBe(false);
    expect(r.residue.join("\n")).toContain("2 member(s) still open");
  });

  it("tells the pull request what actually closed, not what was asked for", async () => {
    // The wrap-up knows the answer by the time it writes here — the member loop
    // is above it — so a comment reciting the target's member list would be
    // claiming a close that failed two calls earlier.
    const { adapter, bodies } = makeWrapupAdapter({ "closeIssue:42": "gh boom" });
    await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });

    const prBody = bodies.at(-1) ?? "";
    expect(prBody).toContain("- #43 — beta");
    expect(prBody).toContain("Still OPEN");
    expect(prBody).toContain("- #42 — alpha");
    expect(prBody).toContain("is KEPT on origin");
    expect(prBody).not.toMatch(/branch is being deleted/);
  });

  it("treats a failed label drop as benign residue and still deletes the branch", async () => {
    const { adapter } = makeWrapupAdapter({ removeLabel: "no such label" });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.closed).toEqual([42, 43]);
    expect(r.branchDeleted).toBe(true);
    expect(r.residue).toHaveLength(2);
    expect(r.residue[0]).toContain("harmless");
  });

  it("still deletes the branch when the pull request will not close", async () => {
    const { adapter } = makeWrapupAdapter({ closePullRequest: "already merged" });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.branchDeleted).toBe(true);
    expect(r.residue.join("\n")).toContain("pull request #9");
  });

  it("drops `land` even when the comment above it failed", async () => {
    // The three pull-request writes are not a transaction, and the label is
    // the one that matters: left on an OPEN pull request it is a landing the
    // next cycle honours, spending a merger worktree and a gate stack to find
    // the branch gone.
    const { adapter, calls } = makeWrapupAdapter({
      commentOnPullRequest: "422 from the forge",
    });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });

    expect(calls.map((c) => c.op)).toContain("removePullRequestLabel");
    expect(calls.map((c) => c.op)).toContain("closePullRequest");
    expect(r.branchDeleted).toBe(true);
    expect(r.residue.join("\n")).toContain("could not be commented on");
  });

  it("keeps going, and says so, when the label will not come off", async () => {
    const { adapter, calls } = makeWrapupAdapter({
      removePullRequestLabel: "no such label",
    });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });

    expect(calls.map((c) => c.op)).toContain("closePullRequest");
    expect(r.branchDeleted).toBe(true);
    expect(r.residue.join("\n")).toContain(`kept its \`${LAND_LABEL}\` label`);
  });

  it("skips the pull request entirely when there is none", async () => {
    const { adapter, calls } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(
      { ...target, pullRequest: 0 },
      adapter,
      { sourceBranch: "main", provenance: "reconciled" },
    );
    expect(r.residue).toEqual([]);
    expect(calls.some((c) => c.op.endsWith("PullRequest"))).toBe(false);
  });

  it("deletes a landed branch that has no members at all", async () => {
    const { adapter } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(
      { ...target, members: [], closeOrder: [], pullRequest: 0 },
      adapter,
      { sourceBranch: "main", provenance: "reconciled" },
    );
    expect(r.closed).toEqual([]);
    expect(r.branchDeleted).toBe(true);
    expect(r.residue).toEqual([]);
  });
});

describe("the prose (#64)", () => {
  it("tells a member why it closed and names its siblings", () => {
    const body = CHUNK_MEMBER_CLOSED_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      others: [{ number: 43, title: "beta" }],
    });
    expect(body).toContain(LAND_LABEL);
    expect(body).toContain("sandbar/chunk-42-alpha");
    expect(body).toContain("#43");
    expect(body).toContain(NEEDS_REVIEW_LABEL);
  });

  it("does not claim sandbar landed a chunk a human merged", () => {
    const body = CHUNK_MEMBER_CLOSED_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "reconciled",
      others: [],
    });
    expect(body).toContain("already contained in");
    expect(body).not.toContain("sandbar merged");
  });

  it("does not promise a delete the member comment cannot have seen", () => {
    // It is written inside the member loop: the closes the delete is gated on
    // have not all been attempted yet, so it may say what becomes of the branch
    // but not that it is already gone.
    const body = CHUNK_MEMBER_CLOSED_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      others: [],
    });
    expect(body).not.toMatch(/branch is deleted/);
    expect(body).toContain("retired once every issue on it has closed");
  });

  it("says the PR is closed rather than merged, and lists what actually closed", () => {
    const body = CHUNK_LANDED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      closed: [{ number: 42, title: "alpha" }],
      unclosed: [],
    });
    expect(body).toContain("- #42 — alpha");
    expect(body).toContain("closed rather than merged");
    expect(body).toContain("The chunk branch is being deleted.");
  });

  it("names the members it could NOT close, and does not claim the branch went", () => {
    // The claim #60 had to go back and unpick, one level up: a comment that
    // listed #43 under "Issues closed" while #43 is open two lines above it.
    const body = CHUNK_LANDED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      closed: [{ number: 42, title: "alpha" }],
      unclosed: [{ number: 43, title: "beta" }],
    });
    expect(body).toContain("- #42 — alpha");
    expect(body).toContain("Still OPEN");
    expect(body).toContain("- #43 — beta");
    expect(body).toContain("is KEPT on origin");
    expect(body).not.toMatch(/branch is being deleted/);
  });

  it("says the label was KEPT when the chunk grew under the request", () => {
    // The one comment here that reports a non-event, so it has to say both
    // what arrived and that nothing was spent: a reviewer who saw the label
    // stay and nothing happen would otherwise assume sandbar is broken.
    const body = CHUNK_LAND_DEFERRED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      landedNow: [{ number: 43, title: "beta" }],
    });
    expect(body).toContain("#43 — beta");
    expect(body).toContain(`\`${LAND_LABEL}\` label is untouched`);
    expect(body).not.toMatch(/has been removed/);
  });

  it("says the land label was removed when the merge was abandoned", () => {
    const body = CHUNK_LAND_ABANDONED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      mode: "conflict",
      reason: "two branches rewrote the same file",
      attempts: [resolveAttempt(1), resolveAttempt(2)],
      conflictPaths: ["src/run.ts"],
    });
    expect(body).toContain("conflicted");
    // The COUNT comes from the journal, not from the budget: a loop that
    // halted on an infra failure spent fewer attempts than it was allowed, and
    // reporting the cap would describe attempts that never happened (#67).
    expect(body).toContain("2 attempts");
    expect(body).toContain("two branches rewrote the same file");
    expect(body).toContain(`\`${LAND_LABEL}\` label has been removed`);
  });

  // #67 — a reviewer looking at a parked chunk gets the same diagnostics an
  // issue's author does: what conflicted, what each attempt did, where to read
  // the output.
  it("carries the conflicted paths, the per-attempt outcome and the log paths", () => {
    const body = CHUNK_LAND_ABANDONED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      mode: "conflict",
      reason: "two branches rewrote the same file",
      attempts: [
        resolveAttempt(1, { end: "timeout", exitCode: null, signal: "SIGTERM", durationMs: 600_777 }),
        resolveAttempt(2),
      ],
      conflictPaths: ["src/run.ts", "CLAUDE.md"],
    });
    expect(body).toContain("`src/run.ts`");
    expect(body).toContain("`CLAUDE.md`");
    expect(body).toContain("10-minute per-attempt timeout");
    expect(body).toContain("resolve-chunk-42-attempt-2.log");
  });

  // `install-failed` never enters the resolve loop, so there is no journal to
  // report — and an empty "what each attempt did" heading would read as four
  // attempts that produced nothing.
  it("renders no attempt list when the loop never ran", () => {
    const body = CHUNK_LAND_ABANDONED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      mode: "install-failed",
      reason: "",
      attempts: [],
      conflictPaths: [],
    });
    expect(body).toContain("npm install");
    expect(body).not.toContain("What each attempt did");
    expect(body).not.toContain("Conflicted path");
  });
});

describe("wrapUpLandedChunk never throws (#64)", () => {
  it("finishes the wrap-up when the log sink throws", async () => {
    // The merge phase hands it a sink that throws once the source branch has
    // moved — `merger.ts` stops wrapping errors past that point on purpose. A
    // failed log write must not abandon a member's close halfway through.
    const { adapter, calls } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
      log: () => {
        throw new Error("ENOSPC");
      },
    });

    expect(r.closed).toEqual([42, 43]);
    expect(r.branchDeleted).toBe(true);
    expect(r.residue).toEqual([]);
    expect(calls.at(-1)?.op).toBe("deleteChunkBranch");
  });
});

// #64 — reading the residue back. Both of `run.ts`'s reports are built from
// this, and the way they were wrong before was arithmetic and a promise: a
// count of every chunk over the lines of some of them, and "the next run
// retries these" said of a chunk whose branch is gone.
describe("chunkResidue and the banners it feeds (#64)", () => {
  const wrapup = (
    branch: string,
    branchDeleted: boolean,
    residue: readonly string[],
    members: ChunkWrapup["target"]["members"] = target.members,
  ): ChunkWrapup => ({
    target: { ...target, branch, members },
    closed: [],
    branchDeleted,
    residue,
  });

  it("splits on the branch, which is the question 'will anything retry this?'", () => {
    const clean = wrapup("sandbar/chunk-1-clean", true, []);
    const untidy = wrapup("sandbar/chunk-2-untidy", true, ["a stray label"]);
    const kept = wrapup("sandbar/chunk-3-kept", false, ["#9 would not close"]);

    expect(chunkResidue([clean, untidy, kept])).toEqual({
      kept: [kept],
      untidy: [untidy],
      unnamed: [],
    });
  });

  it("calls a chunk that retired having named no member its own thing", () => {
    // Every write worked, so there is no residue to split — and the chunk is
    // still news: its branch is gone, so if malformed history hid an open
    // member from the graph, this line is the last mention of it anywhere.
    const unnamed = wrapup("sandbar/chunk-4-unnamed", true, [], []);
    const split = chunkResidue([unnamed]);

    expect(split).toEqual({ kept: [], untidy: [], unnamed: [unnamed] });
    const banner = CHUNK_LANDED_UNNAMED_BANNER({
      chunks: split.unnamed,
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(banner).toContain("knew no member issue");
    expect(banner).toContain("sandbar/chunk-4-unnamed");
    expect(banner).toContain(NEEDS_REVIEW_LABEL);
    expect(banner).toContain("no later run will find it");
  });

  it("says the reconciler FOUND such a chunk rather than landing it", () => {
    expect(
      CHUNK_LANDED_UNNAMED_BANNER({
        chunks: [wrapup("sandbar/chunk-4-unnamed", true, [], [])],
        sourceBranch: "main",
        provenance: "reconciled",
      }),
    ).toContain("found 1 chunk(s) already on");
  });

  it("does not call a KEPT branch unnamed, whatever it named", () => {
    // The delete is what makes it final, so a branch still on origin is the
    // kept case and nothing else: the next cycle looks at it again.
    expect(
      chunkResidue([wrapup("sandbar/chunk-5-kept", false, ["#9 open"], [])])
        .unnamed,
    ).toEqual([]);
  });

  it("counts the chunks the lines came from, not every chunk that retired", () => {
    // Two landing cleanly and one leaving a stray label is ONE chunk with
    // bookkeeping left over. Saying three sends a human looking for leftovers
    // that are not there.
    const { untidy } = chunkResidue([
      wrapup("sandbar/chunk-1-a", true, []),
      wrapup("sandbar/chunk-2-b", true, []),
      wrapup("sandbar/chunk-3-c", true, ["a stray label"]),
    ]);
    const banner = CHUNK_RESIDUE_RETIRED_BANNER({
      chunks: untidy,
      sourceBranch: "main",
      provenance: "sandbar",
    });

    expect(banner).toContain("retired 1 chunk(s)");
    expect(banner).toContain("a stray label");
    expect(banner).not.toContain("sandbar/chunk-1-a");
  });

  it("promises no retry for a chunk whose branch is gone", () => {
    // The claim that was wrong: nothing looks for a retired chunk again,
    // because the branch a reconciler would find it through is deleted.
    const banner = CHUNK_RESIDUE_RETIRED_BANNER({
      chunks: [wrapup("sandbar/chunk-3-c", true, ["a stray label"])],
      sourceBranch: "main",
      provenance: "reconciled",
    });

    expect(banner).toContain("NOTHING retries these");
    expect(banner).toContain("cosmetic");
    expect(banner).not.toMatch(/next (run|cycle)/);
    // …and it says which pass is speaking: a chunk a human merged was not
    // landed by sandbar.
    expect(banner).toContain("reconciled and retired");
  });

  it("promises exactly one retry for a chunk whose branch was kept", () => {
    const banner = CHUNK_RESIDUE_KEPT_BANNER({
      chunks: [wrapup("sandbar/chunk-3-kept", false, ["#9 would not close"])],
      sourceBranch: "main",
      provenance: "sandbar",
    });

    expect(banner).toContain("landed 1 chunk(s)");
    expect(banner).toContain("#9 would not close");
    expect(banner).toContain("KEPT on origin");
    expect(banner).toContain("next cycle's reconciler");
  });

  it("says the reconciler found a chunk rather than landing it", () => {
    expect(
      CHUNK_RESIDUE_KEPT_BANNER({
        chunks: [wrapup("sandbar/chunk-3-kept", false, ["#9 would not close"])],
        sourceBranch: "main",
        provenance: "reconciled",
      }),
    ).toContain("found 1 chunk(s) already on");
  });
});
