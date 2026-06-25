// Locks the sandcastle→sandbar transition contract (issue #11): new resources
// are created with the sandbar prefixes, but the sweep/clean paths must keep
// recognizing the legacy sandcastle prefixes until existing repos have
// drained their old branches/containers. If a refactor drops the legacy
// entries prematurely, those artifacts would be silently orphaned.

import { describe, expect, it } from "vitest";

import {
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
