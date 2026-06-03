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
