import { describe, expect, it } from "vitest";
import { SandbarError } from "./errors.js";
import {
  DEFAULT_ADR_DIR,
  DEFAULT_CHECK_POLL_INTERVAL_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_INTEGRATION_BRANCH,
  DEFAULT_NO_CHECKS_GRACE_MS,
  DEFAULT_DB_READINESS_TIMEOUT_MS,
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
  // Required (#20): the engine is repo identity — sandbar ships no DB preset.
  dbSidecar: {
    image: "docker.io/library/mariadb:10.11",
    containerEnv: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "widgets" },
    port: 3306,
    readinessCommand: ["mysql", "-uroot", "-e", "SELECT 1"],
    gateEnv: { DB_USER: "root", DB_PASSWORD: "", DB_NAME: "widgets" },
  },
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

  it("fills the dbSidecar block's defaultable fields (#20)", () => {
    const r = resolveConfig(minimal);
    expect(r.dbSidecar.readinessTimeoutMs).toBe(DEFAULT_DB_READINESS_TIMEOUT_MS);
    expect(r.dbSidecar.containerArgs).toEqual([]);
    expect(r.dbSidecar.initMounts).toEqual([]);
    expect(r.dbSidecar.postReadyCommands).toEqual([]);
    // Required sub-fields pass through untouched.
    expect(r.dbSidecar.image).toBe("docker.io/library/mariadb:10.11");
    expect(r.dbSidecar.port).toBe(3306);
    expect(r.dbSidecar.gateEnv).toEqual(minimal.dbSidecar.gateEnv);
  });

  it("honours explicit dbSidecar deviations", () => {
    const r = resolveConfig({
      ...minimal,
      dbSidecar: {
        ...minimal.dbSidecar,
        readinessTimeoutMs: 120_000,
        containerArgs: ["--sql-mode=NO_ENGINE_SUBSTITUTION"],
        initMounts: [
          {
            hostPath: "tests/fixtures/schema.sql",
            containerPath: "/docker-entrypoint-initdb.d/schema.sql",
          },
        ],
        postReadyCommands: [["mysql", "-uroot", "-e", "CREATE DATABASE IF NOT EXISTS widgets_test"]],
      },
    });
    expect(r.dbSidecar.readinessTimeoutMs).toBe(120_000);
    expect(r.dbSidecar.containerArgs).toEqual(["--sql-mode=NO_ENGINE_SUBSTITUTION"]);
    expect(r.dbSidecar.initMounts).toHaveLength(1);
    expect(r.dbSidecar.postReadyCommands).toHaveLength(1);
  });
});

describe("resolveMergeMode (#22)", () => {
  it("defaults to direct — an existing consumer keeps today's push", () => {
    expect(resolveConfig(minimal).mergeMode).toEqual({ kind: "direct" });
  });

  it("fills the verified defaults", () => {
    const r = resolveConfig({
      ...minimal,
      mergeMode: { kind: "verified", requiredChecks: ["tests"] },
    });
    expect(r.mergeMode).toEqual({
      kind: "verified",
      integrationBranch: DEFAULT_INTEGRATION_BRANCH,
      requiredChecks: ["tests"],
      checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_CHECK_POLL_INTERVAL_MS,
      noChecksGraceMs: DEFAULT_NO_CHECKS_GRACE_MS,
      openPullRequest: false,
    });
  });

  it("keeps deviating knobs", () => {
    const r = resolveConfig({
      ...minimal,
      sourceBranch: "trunk",
      mergeMode: {
        kind: "verified",
        integrationBranch: "ci/staging",
        requiredChecks: ["tests"],
        checkTimeoutMs: 1000,
        pollIntervalMs: 100,
        noChecksGraceMs: 50,
        openPullRequest: true,
      },
    });
    expect(r.mergeMode).toEqual({
      kind: "verified",
      integrationBranch: "ci/staging",
      requiredChecks: ["tests"],
      checkTimeoutMs: 1000,
      pollIntervalMs: 100,
      noChecksGraceMs: 50,
      openPullRequest: true,
    });
  });

  it("refuses an integration branch equal to the source branch", () => {
    // Otherwise 'verify then fast-forward' degrades to an unverified direct
    // push — the exact hole the mode exists to close.
    expect(() =>
      resolveConfig({
        ...minimal,
        mergeMode: {
          kind: "verified",
          integrationBranch: "main",
          requiredChecks: ["tests"],
        },
      }),
    ).toThrow(/must differ from sourceBranch/);
  });

  it.each([
    { label: "empty", branch: "" },
    { label: "whitespace-padded onto the source branch", branch: " main " },
    { label: "a full ref", branch: "refs/heads/ci" },
    { label: "inside the reaped issue-branch namespace", branch: "sandbar/issue-x" },
  ])("refuses an integration branch that is $label", ({ branch }) => {
    expect(() =>
      resolveConfig({
        ...minimal,
        mergeMode: {
          kind: "verified",
          integrationBranch: branch,
          requiredChecks: ["tests"],
        },
      }),
    ).toThrow(SandbarError);
  });

  it("refuses verified mode with no requiredChecks", () => {
    // Without a named floor, "verified" degrades to "nothing visible was
    // failing at the instant I looked" — it cannot tell a check that has not
    // started from one that will never run.
    expect(() =>
      resolveConfig({
        ...minimal,
        mergeMode: { kind: "verified", requiredChecks: [] },
      }),
    ).toThrow(/requiredChecks/);
  });

  it.each([
    { checkTimeoutMs: 0 },
    { pollIntervalMs: -1 },
    // NaN passes a bare `<= 0` check, and `elapsed >= NaN` is never true — the
    // poll loop would spin forever holding the single-instance lock. This is
    // what `Number(process.env.UNSET)` produces.
    { checkTimeoutMs: Number.NaN },
    { pollIntervalMs: Number.NaN },
    { checkTimeoutMs: Number.POSITIVE_INFINITY },
    { noChecksGraceMs: Number.NaN },
  ])("refuses a non-finite or non-positive %o", (over) => {
    expect(() =>
      resolveConfig({
        ...minimal,
        mergeMode: { kind: "verified", requiredChecks: ["tests"], ...over },
      }),
    ).toThrow(/positive, finite|must be positive/);
  });

  it("refuses a poll interval longer than the whole timeout", () => {
    expect(() =>
      resolveConfig({
        ...minimal,
        mergeMode: {
          kind: "verified",
          requiredChecks: ["tests"],
          checkTimeoutMs: 1_000,
          pollIntervalMs: 5_000,
        },
      }),
    ).toThrow(/must not exceed/);
  });
});
