import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADR_DIR,
  DEFAULT_CLAUDE_MD_PATH,
  DEFAULT_CONTAINERFILE_PATH,
  DEFAULT_CONTEXT_MD_PATH,
  DEFAULT_ENV_FILE_PATH,
  DEFAULT_MAX_IMPL_ATTEMPTS,
  DEFAULT_MAX_REVIEW_ROUNDS,
  DEFAULT_MAX_TOTAL_ISSUES,
  DEFAULT_IMPLEMENTER_MODEL_ID,
  DEFAULT_REVIEWER_MODEL_ID,
  DEFAULT_MERGER_MODEL_ID,
  DEFAULT_SOURCE_BRANCH,
  DEFAULT_WORK_DIR,
  DEFAULT_LABELS,
  resolveConfig,
  type RunConfig,
} from "./config.js";

// A deviations-only config: only the genuinely-required, no-sensible-default
// fields. Everything else must fall through to a documented default.
const minimal: RunConfig = {
  ghOwner: "acme",
  ghRepo: "widgets",
  gateImage: "localhost/sandbar:latest",
  gateCommands: {
    check: { cmd: "npm", args: ["run", "check"] },
    test: { cmd: "npm", args: ["test"] },
  },
  botName: "sandbar-bot",
  botEmail: "bot@acme.dev",
  sandboxHooks: {},
};

describe("resolveConfig", () => {
  it("fills every defaultable field from a deviations-only config", () => {
    const r = resolveConfig(minimal);
    expect(r.cwd).toBe(process.cwd());
    expect(r.workDir).toBe(DEFAULT_WORK_DIR);
    expect(r.sourceBranch).toBe(DEFAULT_SOURCE_BRANCH);
    expect(r.containerfilePath).toBe(DEFAULT_CONTAINERFILE_PATH);
    expect(r.implementerModelId).toBe(DEFAULT_IMPLEMENTER_MODEL_ID);
    expect(r.reviewerModelId).toBe(DEFAULT_REVIEWER_MODEL_ID);
    expect(r.mergerModelId).toBe(DEFAULT_MERGER_MODEL_ID);
    expect(r.claudeMdPath).toBe(DEFAULT_CLAUDE_MD_PATH);
    expect(r.contextMdPath).toBe(DEFAULT_CONTEXT_MD_PATH);
    expect(r.adrDir).toBe(DEFAULT_ADR_DIR);
    expect(r.envFilePath).toBe(DEFAULT_ENV_FILE_PATH);
    expect(r.maxImplAttempts).toBe(DEFAULT_MAX_IMPL_ATTEMPTS);
    expect(r.maxReviewRounds).toBe(DEFAULT_MAX_REVIEW_ROUNDS);
    expect(r.maxTotalIssues).toBe(DEFAULT_MAX_TOTAL_ISSUES);
    expect(r.copyToWorktree).toEqual([]);
    expect(r.labels).toEqual(DEFAULT_LABELS);
    // No conventional value → stays undefined.
    expect(r.codingStandardsPath).toBeUndefined();
  });

  it("derives coauthorTrailer from bot identity when unset", () => {
    const r = resolveConfig(minimal);
    expect(r.coauthorTrailer).toBe("Co-authored-by: sandbar-bot <bot@acme.dev>");
  });

  it("honours explicit deviations over defaults", () => {
    const r = resolveConfig({
      ...minimal,
      sourceBranch: "develop",
      implementerModelId: "claude-haiku-4-5-20251001",
      maxReviewRounds: 2,
      coauthorTrailer: "Co-authored-by: Someone Else <x@y.z>",
      copyToWorktree: [".npmrc"],
    });
    expect(r.sourceBranch).toBe("develop");
    expect(r.implementerModelId).toBe("claude-haiku-4-5-20251001");
    expect(r.maxReviewRounds).toBe(2);
    expect(r.coauthorTrailer).toBe("Co-authored-by: Someone Else <x@y.z>");
    expect(r.copyToWorktree).toEqual([".npmrc"]);
  });

  it("defaults every agent role to the version-agnostic opus alias", () => {
    const r = resolveConfig(minimal);
    expect(r.implementerModelId).toBe("opus");
    expect(r.reviewerModelId).toBe("opus");
    expect(r.mergerModelId).toBe("opus");
  });

  it("resolves each role's model independently", () => {
    const r = resolveConfig({
      ...minimal,
      implementerModelId: "claude-haiku-4-5-20251001",
      mergerModelId: "claude-sonnet-4-6",
    });
    // Explicit knobs win for their own role...
    expect(r.implementerModelId).toBe("claude-haiku-4-5-20251001");
    expect(r.mergerModelId).toBe("claude-sonnet-4-6");
    // ...and an unset role still falls through to its own default — there is
    // no global model knob that could bleed across roles.
    expect(r.reviewerModelId).toBe(DEFAULT_REVIEWER_MODEL_ID);
  });

  it("merges a partial label override onto the default vocabulary", () => {
    const r = resolveConfig({ ...minimal, labels: { agentStuck: "blocked" } });
    expect(r.labels).toEqual({
      needsInfo: DEFAULT_LABELS.needsInfo,
      agentStuck: "blocked",
    });
  });
});
