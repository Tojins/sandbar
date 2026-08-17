// Locks the sandcastle→sandbar transition contract (issue #11): new resources
// are created with the sandbar prefixes, but the sweep/clean paths must keep
// recognizing the legacy sandcastle prefixes until existing repos have
// drained their old branches/containers. If a refactor drops the legacy
// entries prematurely, those artifacts would be silently orphaned.

import { describe, expect, it } from "vitest";

import {
  networkNameFor,
  podNameFor,
  stackContainerNameFor,
  ALL_BRANCH_PREFIXES,
  ALL_RESOURCE_PREFIXES,
  BRANCH_PREFIX,
  LEGACY_BRANCH_PREFIXES,
  LEGACY_RESOURCE_PREFIXES,
  RESOURCE_PREFIX,
  issueNumberFromBranch,
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

// The sweeper finds orphans by name prefix, so the names have to carry it.
// The one resource that CANNOT be found that way is the pod's infra container
// (`<pod-id-prefix>-infra`, a podman-assigned hash) — which is why the sweep
// removes pods, not just containers, and why the pod name is what has to match.
describe("gate-stack resource names (#24)", () => {
  it("prefixes every name so the orphan sweep can find it", () => {
    expect(networkNameFor("42").startsWith(RESOURCE_PREFIX)).toBe(true);
    expect(podNameFor("42").startsWith(RESOURCE_PREFIX)).toBe(true);
    expect(stackContainerNameFor("42", "db").startsWith(RESOURCE_PREFIX)).toBe(true);
  });

  it("gives networks and pods their own sub-prefixes", () => {
    expect(networkNameFor("42")).toBe("sandbar-net-42");
    expect(podNameFor("42")).toBe("sandbar-pod-42");
    expect(stackContainerNameFor("42", "db")).toBe("sandbar-42-db");
  });

  it("keeps the merger's stack disjoint from every issue's", () => {
    // Issue ids are numeric, so "merger" can never collide — the two stacks run
    // in the same process and would otherwise tear each other's pods down.
    expect(podNameFor("merger")).not.toBe(podNameFor("42"));
    expect(stackContainerNameFor("merger", "db")).toBe("sandbar-merger-db");
  });
});
