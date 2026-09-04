// Locks the sandcastle→sandbar transition contract (issue #11): new resources
// are created with the sandbar prefixes, but the sweep/clean paths must keep
// recognizing the legacy sandcastle prefixes until existing repos have
// drained their old branches/containers. If a refactor drops the legacy
// entries prematurely, those artifacts would be silently orphaned.

import { describe, expect, it } from "vitest";

import {
  gateScope,
  isScopedResourceName,
  networkNameFor,
  podNameFor,
  runScope,
  sandboxContainerNameFor,
  scopedResourcePrefix,
  stackContainerNameFor,
  ALL_BRANCH_INFIXES,
  ALL_BRANCH_PREFIXES,
  ALL_RESOURCE_PREFIXES,
  BRANCH_PREFIX,
  LEGACY_BRANCH_PREFIXES,
  LEGACY_RESOURCE_PREFIXES,
  MEMBER_BRANCH_INFIX,
  RESOURCE_PREFIX,
  ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS,
  ORIGIN_CHUNK_BRANCH_REFGLOBS,
  ORIGIN_MEMBER_BRANCH_FETCH_REFSPECS,
  ORIGIN_MEMBER_BRANCH_REFGLOBS,
  SANDBAR_BRANCH_REFGLOBS,
  STRANDED_HEAD_REFGLOB,
  branchNameFromOriginRef,
  chunkBranchName,
  issueBranchName,
  issueNumberFromBranch,
  kebabSlug,
  rootIssueFromChunkBranch,
  strandedHeadRef,
} from "./naming.js";

describe("naming transition contract", () => {
  it("creates with the sandbar prefixes", () => {
    expect(BRANCH_PREFIX).toBe("sandbar/");
    expect(RESOURCE_PREFIX).toBe("sandbar-");
  });

  it("still recognizes the legacy sandcastle prefixes for cleanup", () => {
    expect(LEGACY_BRANCH_PREFIXES).toContain("sandcastle/");
    expect(LEGACY_RESOURCE_PREFIXES).toContain("sandcastle-");
  });

  it("cleanup matchers cover current + legacy, current first", () => {
    expect(ALL_BRANCH_PREFIXES).toEqual([
      BRANCH_PREFIX,
      ...LEGACY_BRANCH_PREFIXES,
    ]);
    expect(ALL_RESOURCE_PREFIXES).toEqual([
      RESOURCE_PREFIX,
      ...LEGACY_RESOURCE_PREFIXES,
    ]);
  });
});

describe("issueNumberFromBranch", () => {
  it("extracts the issue number from a sandbar branch", () => {
    expect(issueNumberFromBranch("sandbar/issue-296-keyword-escape")).toBe(296);
  });

  it("recognizes the legacy sandcastle prefix", () => {
    expect(issueNumberFromBranch("sandcastle/issue-42-foo")).toBe(42);
  });

  it("matches a bare `issue-<n>` with no slug", () => {
    expect(issueNumberFromBranch("sandbar/issue-7")).toBe(7);
  });

  it("returns null for an unknown prefix", () => {
    expect(issueNumberFromBranch("feature/issue-7-foo")).toBeNull();
  });

  it("returns null when the prefix matches but the shape doesn't", () => {
    expect(issueNumberFromBranch("sandbar/hotfix-7")).toBeNull();
    expect(issueNumberFromBranch("sandbar/issue-foo")).toBeNull();
    expect(issueNumberFromBranch("sandbar/issue-")).toBeNull();
  });

  it("does not treat a non-separator suffix digit as part of the number", () => {
    // `issue-12x-...` is malformed; the `(?:-|$)` boundary rejects it rather
    // than silently parsing 12.
    expect(issueNumberFromBranch("sandbar/issue-12x-foo")).toBeNull();
  });
});

describe("kebabSlug", () => {
  it("lowercases ASCII", () => {
    expect(kebabSlug("Foo Bar")).toBe("foo-bar");
  });

  it("hyphenates non-alphanumeric runs", () => {
    expect(kebabSlug("Foo: bar's & baz!")).toBe("foo-bar-s-baz");
  });

  it("strips diacritics", () => {
    expect(kebabSlug("Café Münchën")).toBe("cafe-munchen");
  });

  it("trims leading/trailing hyphens", () => {
    expect(kebabSlug("  --foo--bar  ")).toBe("foo-bar");
  });

  it("collapses non-ASCII to a single hyphen", () => {
    expect(kebabSlug("foo→bar")).toBe("foo-bar");
  });
});

// #58 gave sandbar a SECOND branch shape. The globs, the builders and the two
// parsers have to agree about both, because preflight's cleanup and the
// reserved-namespace check on `integrationBranch` are the same statement made
// three times if they don't.
describe("branch names (#58)", () => {
  it("strips the remote from a short origin ref", () => {
    expect(branchNameFromOriginRef("origin/sandbar/member-42")).toBe(
      "sandbar/member-42",
    );
  });

  it("builds the issue shape exactly as the planner always spelled it", () => {
    expect(issueBranchName(296, "Keyword escape")).toBe(
      "sandbar/issue-296-keyword-escape",
    );
  });

  it("builds the chunk shape from the ROOT issue", () => {
    expect(chunkBranchName(58, "Chunk derivation")).toBe(
      "sandbar/chunk-58-chunk-derivation",
    );
  });

  it("round-trips each shape through its own parser", () => {
    expect(issueNumberFromBranch(issueBranchName(7, "Foo bar"))).toBe(7);
    expect(rootIssueFromChunkBranch(chunkBranchName(7, "Foo bar"))).toBe(7);
  });

  // The load-bearing half: a chunk branch read as an issue branch would send a
  // chunk's root number into preflight's resume path as if it named one issue's
  // stranded work.
  it("does not read one shape as the other", () => {
    expect(issueNumberFromBranch("sandbar/chunk-58-derivation")).toBeNull();
    expect(rootIssueFromChunkBranch("sandbar/issue-58-derivation")).toBeNull();
  });

  it("applies the same shape rules to chunk branches as to issue ones", () => {
    expect(rootIssueFromChunkBranch("sandbar/chunk-7")).toBe(7);
    expect(rootIssueFromChunkBranch("feature/chunk-7-foo")).toBeNull();
    expect(rootIssueFromChunkBranch("sandbar/chunk-foo")).toBeNull();
    expect(rootIssueFromChunkBranch("sandbar/chunk-12x-foo")).toBeNull();
  });

  it("globs every prefix × local branch shape", () => {
    expect([...SANDBAR_BRANCH_REFGLOBS].sort()).toEqual(
      [
        "refs/heads/sandbar/issue-*",
        "refs/heads/sandbar/chunk-*",
        "refs/heads/sandcastle/issue-*",
        "refs/heads/sandcastle/chunk-*",
      ].sort(),
    );
  });

  // #60 — the remote side of the same namespace. A chunk branch lives on
  // origin, so "what is already on this chunk?" is a question about
  // remote-tracking refs, and the refspec that fetches them and the glob that
  // enumerates them have to describe the same set.
  it("names origin's chunk branches for both fetching and enumerating", () => {
    expect([...ORIGIN_CHUNK_BRANCH_REFGLOBS].sort()).toEqual(
      [
        "refs/remotes/origin/sandbar/chunk-*",
        "refs/remotes/origin/sandcastle/chunk-*",
      ].sort(),
    );
    expect([...ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS].sort()).toEqual(
      [
        "+refs/heads/sandbar/chunk-*:refs/remotes/origin/sandbar/chunk-*",
        "+refs/heads/sandcastle/chunk-*:refs/remotes/origin/sandcastle/chunk-*",
      ].sort(),
    );
    // Every refspec's destination is one of the globs — the pair cannot drift
    // into fetching one namespace and reading another.
    for (const spec of ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS) {
      expect(ORIGIN_CHUNK_BRANCH_REFGLOBS).toContain(spec.split(":")[1]);
    }
  });

  it("names origin's landing-only member refs", () => {
    expect(ORIGIN_MEMBER_BRANCH_REFGLOBS).toContain(
      "refs/remotes/origin/sandbar/member-*",
    );
    expect(ORIGIN_MEMBER_BRANCH_FETCH_REFSPECS).toContain(
      "+refs/heads/sandbar/member-*:refs/remotes/origin/sandbar/member-*",
    );
  });

  it("reserves member refs with every sandbar-owned branch shape", () => {
    expect(ALL_BRANCH_INFIXES).toContain(MEMBER_BRANCH_INFIX);
    expect(SANDBAR_BRANCH_REFGLOBS).not.toContain(
      "refs/heads/sandbar/member-*",
    );
  });

  it("keeps origin's chunk refs out of the local branch globs", () => {
    // `listSandbarBranches` hands SANDBAR_BRANCH_REFGLOBS to `for-each-ref` and
    // treats every hit as a local branch it may delete.
    for (const glob of SANDBAR_BRANCH_REFGLOBS) {
      expect(glob.startsWith("refs/heads/")).toBe(true);
    }
  });

  it("keeps stranded HEAD ref naming and enumeration aligned", () => {
    expect(STRANDED_HEAD_REFGLOB).toBe("refs/sandbar/stranded/*");
    expect(strandedHeadRef("deadbeef")).toBe("refs/sandbar/stranded/deadbeef");
    expect(
      strandedHeadRef("deadbeef").startsWith(STRANDED_HEAD_REFGLOB.slice(0, -1)),
    ).toBe(true);
  });

  it("globs match what the builders produce", () => {
    const matches = (branch: string): boolean =>
      SANDBAR_BRANCH_REFGLOBS.some((glob) =>
        `refs/heads/${branch}`.startsWith(glob.slice(0, -1)),
      );
    expect(matches(issueBranchName(1, "a"))).toBe(true);
    expect(matches(chunkBranchName(1, "a"))).toBe(true);
    expect(matches("sandbar/something-else")).toBe(false);
  });
});

// The sweeper finds orphans by name prefix, so the names have to carry it.
// The one resource that CANNOT be found that way is the pod's infra container
// (`<pod-id-prefix>-infra`, a podman-assigned hash) — which is why the sweep
// removes pods, not just containers, and why the pod name is what has to match.
describe("gate-stack resource names (#24)", () => {
  const S = runScope("/some/workdir");

  it("prefixes every name so the orphan sweep can find it", () => {
    expect(networkNameFor(S, "42").startsWith(RESOURCE_PREFIX)).toBe(true);
    expect(podNameFor(S, "42").startsWith(RESOURCE_PREFIX)).toBe(true);
    expect(stackContainerNameFor(S, "42", "db").startsWith(RESOURCE_PREFIX)).toBe(
      true,
    );
  });

  it("gives networks and pods their own sub-prefixes, under the scope", () => {
    expect(networkNameFor(S, "42")).toBe(`sandbar-${S}-net-42`);
    expect(podNameFor(S, "42")).toBe(`sandbar-${S}-pod-42`);
    expect(stackContainerNameFor(S, "42", "db")).toBe(`sandbar-${S}-42-db`);
  });

  // #44. The sandbox siblings share a scope with the gate's containers and the
  // gate force-removes its own by name before every gate run, so an alias is
  // one stack reaping the other's live container mid-attempt. The `sbx-`
  // segment is what makes that impossible, and it is only impossible because no
  // stackId can produce it — ids are issue numbers or the literal "merger".
  it("keeps a sandbox sibling out of every gate container's name", () => {
    expect(sandboxContainerNameFor(S, "42", "db")).toBe(`sandbar-${S}-sbx-42-db`);
    expect(sandboxContainerNameFor(S, "42", "db")).not.toBe(
      stackContainerNameFor(S, "42", "db"),
    );
    // The alias would need a stack whose id is literally "sbx", and the one
    // non-numeric id sandbar mints is "merger".
    expect(sandboxContainerNameFor(S, "42", "db")).toBe(
      stackContainerNameFor(S, "sbx", "42-db"),
    );
    expect(stackContainerNameFor(S, "merger", "db")).not.toBe(
      sandboxContainerNameFor(S, "merger", "db"),
    );
  });

  // No new pod and no new network under the anchor-chain topology, so the
  // existing scoped sweep reaps these for free — which is only true while the
  // name carries the scope.
  it("scopes a sandbox sibling so the orphan sweep can reach it", () => {
    expect(sandboxContainerNameFor(S, "42", "db")).toContain(
      scopedResourcePrefix(S),
    );
  });

  it("keeps the merger's stack disjoint from every issue's", () => {
    // Issue ids are numeric, so "merger" can never collide — the two stacks run
    // in the same process and would otherwise tear each other's pods down.
    expect(podNameFor(S, "merger")).not.toBe(podNameFor(S, "42"));
    expect(stackContainerNameFor(S, "merger", "db")).toBe(
      `sandbar-${S}-merger-db`,
    );
  });
});

// #28: podman names are host-global, the lock is per-workdir. Without a scope
// segment, two runs against different repos both legitimately hold their own
// lock and then destroy each other's pods — by namesake collision on create,
// and by the bare-prefix orphan sweep between cycles.
describe("run scope (#28)", () => {
  it("is stable for a workdir and distinct between workdirs", () => {
    expect(runScope("/a/.sandbar")).toBe(runScope("/a/.sandbar"));
    expect(runScope("/a/.sandbar")).not.toBe(runScope("/b/.sandbar"));
  });

  // The scope only means anything if it partitions the host the same way the
  // LOCK does, and proper-lockfile resolves symlinks on the path it locks
  // (`realpath: true` is its default). So `runScope` is a pure hash and the
  // canonicalisation is the caller's job — these pin both halves of why.
  it("is a pure hash of the string, so the caller must canonicalise", () => {
    // Same directory, two spellings: ONE lock, and so it must be ONE scope.
    // The caller passes realpath; if it ever passes the configured string
    // instead, these two diverge and a crashed run's debris lands in a scope no
    // later run computes and no report names — invisible and unreapable.
    expect(runScope("/a/./.sandbar")).not.toBe(runScope("/a/.sandbar"));
    // Two DIFFERENT directories both configured with a relative cwd collapse to
    // the same string, hence the same scope, while correctly holding two locks.
    // That is #28 verbatim, which is why run.ts hashes realpath and not
    // `join(config.cwd, config.workDir)` — `resolveConfig` passes cwd through
    // untouched (config.ts), so a relative one survives to here.
    expect(runScope(".sandbar")).toBe(runScope(".sandbar"));
  });

  it("is a legal podman name segment", () => {
    expect(runScope("/a/.sandbar")).toMatch(/^w[0-9a-f]{8}$/);
  });

  it("makes two workdirs' stacks disjoint at every resource kind", () => {
    const a = runScope("/a/.sandbar");
    const b = runScope("/b/.sandbar");
    expect(podNameFor(a, "42")).not.toBe(podNameFor(b, "42"));
    expect(networkNameFor(a, "42")).not.toBe(networkNameFor(b, "42"));
    expect(stackContainerNameFor(a, "42", "db")).not.toBe(
      stackContainerNameFor(b, "42", "db"),
    );
  });

  it("keeps one run's sweep prefix from reaching another run's names", () => {
    const a = runScope("/a/.sandbar");
    const b = runScope("/b/.sandbar");
    for (const name of [
      podNameFor(b, "42"),
      networkNameFor(b, "42"),
      stackContainerNameFor(b, "42", "db"),
    ]) {
      expect(name.startsWith(scopedResourcePrefix(a))).toBe(false);
    }
  });

  it("recognizes scoped names and only scoped names", () => {
    const S = runScope("/a/.sandbar");
    expect(isScopedResourceName(podNameFor(S, "42"))).toBe(true);
    expect(isScopedResourceName(stackContainerNameFor(S, "42", "db"))).toBe(true);
    // Pre-#28 names, which the debris report must still see.
    expect(isScopedResourceName("sandbar-pod-42")).toBe(false);
    expect(isScopedResourceName("sandbar-net-42")).toBe(false);
    expect(isScopedResourceName("sandbar-42-db")).toBe(false);
    expect(isScopedResourceName("sandcastle-pod-42")).toBe(false);
  });

  it("does not mistake a pre-#28 agent-sandbox uuid name for a scope", () => {
    // The leading `w` carries this: a uuid's first segment is also 8 chars, but
    // hex can never start with `w`, so `sandbar-<uuid>` stays unscoped and gets
    // reported as debris rather than silently claimed by some run's sweep.
    expect(isScopedResourceName("sandbar-1a2b3c4d-5e6f-7081-9234-56789abcdef0")).toBe(
      false,
    );
  });
});

// #45 — the standalone gate's scope.
describe("gate scope (#45)", () => {
  it("is stable for a worktree and distinct between worktrees", () => {
    expect(gateScope("/repo")).toBe(gateScope("/repo"));
    expect(gateScope("/repo")).not.toBe(gateScope("/other"));
  });

  // The whole point. A run's sweeps force-remove everything in the scope they
  // are handed, so a `sandbar gate` sharing a run's scope would be torn down by
  // that run's between-cycle sweep mid-verdict — and the likeliest collision is
  // the one that looks safest: a consumer gating the very checkout whose
  // `.sandbar` a run locked, or that directory itself.
  it("never equals the run scope of the same path", () => {
    for (const p of ["/repo", "/repo/.sandbar", "/", "sandbar-gate"]) {
      expect(gateScope(p)).not.toBe(runScope(p));
    }
  });

  it("is a legal podman name segment, so the sweeps see it as SOMEONE's", () => {
    expect(gateScope("/repo")).toMatch(/^w[0-9a-f]{8}$/);
    // Scoped, therefore invisible to `findUnattributableResources`, which
    // reports only names carrying no scope at all — a kept stack must not turn
    // up in the operator's debris report every time a run starts.
    expect(isScopedResourceName(podNameFor(gateScope("/repo"), "gate"))).toBe(
      true,
    );
  });

  // Same argument `runScope` makes one function up: the caller canonicalises,
  // because a tree reached through a symlink getting a second scope means a
  // `--keep` stack the next invocation cannot find.
  it("is a pure hash, so the caller must canonicalise", () => {
    expect(gateScope("/repo/./")).not.toBe(gateScope("/repo"));
  });
});
