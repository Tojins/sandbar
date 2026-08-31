import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { SandbarError } from "./errors.js";
import { DEFAULT_LANE } from "./lanes.js";
import {
  DEFAULT_ADR_DIR,
  DEFAULT_CHECK_POLL_INTERVAL_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_INTEGRATION_BRANCH,
  DEFAULT_NO_CHECKS_GRACE_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_CLAUDE_MD_PATH,
  DEFAULT_CONTAINERFILE_PATH,
  DEFAULT_CONTEXT_MD_PATH,
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
  sandboxImage: "localhost/sandbar:widgets",
  botName: "sandbar-bot",
  botEmail: "bot@acme.dev",
  sandboxHooks: {},
  // Required (#24): what it takes to test this repo is repo identity — sandbar
  // ships no preset. Two containers and two steps is the smallest thing that
  // still exercises both lifecycles.
  gateStack: {
    containers: [
      {
        name: "db",
        image: "docker.io/library/mariadb:10.11",
        lifecycle: "issue",
        env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "widgets" },
        readiness: {
          kind: "healthcheck",
          command: ["mysql", "-uroot", "-e", "SELECT 1"],
        },
      },
      {
        name: "app",
        image: "localhost/sandbar:widgets",
        mountWorktree: "/workspace",
        hold: true,
      },
    ],
    steps: [
      { name: "check", in: "app", command: ["npm", "run", "check"] },
      { name: "test", in: "app", command: ["npm", "test"] },
    ],
  },
};

// #37 — `rebuildOn` on an image nothing runs is inert, and inertness is the
// failure itself: the operator wrote down what the image is a function of and
// sandbar would silently never act on it. Since #46 the agent sandbox counts as
// a use, because its image is resolved against the issue worktree.
describe("resolveConfig: rebuildOn must reach something that runs the image", () => {
  it("accepts rebuildOn on an image the gate stack runs", () => {
    const r = resolveConfig({
      ...minimal,
      images: [
        {
          tag: "localhost/sandbar:widgets",
          containerfile: "Containerfile",
          rebuildOn: ["package-lock.json"],
        },
      ],
    });
    expect(r.images[0]?.rebuildOn).toEqual(["package-lock.json"]);
  });

  it("accepts rebuildOn on an image only the agent sandbox uses (#46)", () => {
    // The issue worktree is prepared before the sandbox is created, so the
    // branch's inputs are on disk in time to be hashed. Refusing this is what
    // sent consumers to compare lockfiles in a boot script inside the sandbox.
    const r = resolveConfig({
      ...minimal,
      sandboxImage: "localhost/sandbar:agent",
      images: [
        {
          tag: "localhost/sandbar:agent",
          containerfile: "Containerfile",
          rebuildOn: ["package-lock.json"],
        },
        { tag: "localhost/sandbar:widgets", containerfile: "Containerfile.gate" },
      ],
    });
    expect(r.images[0]?.rebuildOn).toEqual(["package-lock.json"]);
  });

  it("still refuses rebuildOn on an image neither the sandbox nor a gate container runs", () => {
    expect(() =>
      resolveConfig({
        ...minimal,
        images: [
          { tag: "localhost/sandbar:widgets", containerfile: "Containerfile" },
          {
            tag: "localhost/sandbar:unused",
            containerfile: "Containerfile.unused",
            rebuildOn: ["package-lock.json"],
          },
        ],
      }),
    ).toThrow(SandbarError);
  });
});

describe("resolveConfig", () => {
  it("fills every defaultable field from a deviations-only config", () => {
    const r = resolveConfig(minimal);
    expect(r.cwd).toBe(process.cwd());
    expect(r.workDir).toBe(DEFAULT_WORK_DIR);
    expect(r.sourceBranch).toBe(DEFAULT_SOURCE_BRANCH);
    expect(r.implementerModelId).toBe(DEFAULT_IMPLEMENTER_MODEL_ID);
    expect(r.reviewerModelId).toBe(DEFAULT_REVIEWER_MODEL_ID);
    expect(r.mergerModelId).toBe(DEFAULT_MERGER_MODEL_ID);
    expect(r.claudeMdPath).toBe(DEFAULT_CLAUDE_MD_PATH);
    expect(r.contextMdPath).toBe(DEFAULT_CONTEXT_MD_PATH);
    expect(r.adrDir).toBe(DEFAULT_ADR_DIR);
    // A record, not a path (#38): the empty default is a real configuration —
    // a host whose credentials all come from the process environment still has
    // to DECLARE the keys, because the fallback is per declared key.
    expect(r.env).toEqual({});
    expect(r.maxImplAttempts).toBe(DEFAULT_MAX_IMPL_ATTEMPTS);
    expect(r.maxReviewRounds).toBe(DEFAULT_MAX_REVIEW_ROUNDS);
    expect(r.maxTotalIssues).toBe(DEFAULT_MAX_TOTAL_ISSUES);
    expect(r.copyToWorktree).toEqual([]);
    expect(r.labels).toEqual(DEFAULT_LABELS);
    // Off by default (#65): only a host whose launcher loops on
    // EXIT_CODE_RELAUNCH wants a landing cycle to end the process.
    expect(r.relaunchAfterLanding).toBe(false);
    // The auto lane (#57): the pre-lane behaviour, so a host that never sets
    // this — and this repo — is routed exactly as it was before lanes existed.
    expect(r.defaultLane).toBe(DEFAULT_LANE);
    expect(r.defaultLane).toBe("auto");
    // No conventional value → stays undefined.
    expect(r.codingStandardsPath).toBeUndefined();
  });

  it("passes relaunchAfterLanding through when set (#65)", () => {
    const r = resolveConfig({ ...minimal, relaunchAfterLanding: true });
    expect(r.relaunchAfterLanding).toBe(true);
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

  it("defaults images to building the sandbox image from ./Containerfile", () => {
    const r = resolveConfig(minimal);
    expect(r.images).toEqual([
      {
        tag: "localhost/sandbar:widgets",
        containerfile: DEFAULT_CONTAINERFILE_PATH,
        rebuildOn: [],
      },
    ]);
  });

  it("fills each stack container's defaultable fields (#24)", () => {
    const r = resolveConfig(minimal);
    const db = r.gateStack.containers[0]!;
    expect(db.readinessTimeoutMs).toBe(DEFAULT_READINESS_TIMEOUT_MS);
    expect(db.env).toEqual({ MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "widgets" });
    expect(db.args).toEqual([]);
    expect(db.mounts).toEqual([]);
    expect(db.mountWorktree).toBeNull();
    expect(db.hold).toBe(false);
    expect(db.postReadyCommands).toEqual([]);
  });

  // The safe side: a container wrongly treated as `issue` is reused across
  // attempts with stale branch code in it, and the gate silently re-tests an
  // earlier attempt.
  it("defaults lifecycle to attempt, not issue", () => {
    const r = resolveConfig(minimal);
    expect(r.gateStack.containers[1]!.lifecycle).toBe("attempt");
    expect(r.gateStack.containers[0]!.lifecycle).toBe("issue");
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
        integrationBranch: "sandbar/staging",
        requiredChecks: ["tests"],
        checkTimeoutMs: 1000,
        pollIntervalMs: 100,
        noChecksGraceMs: 50,
        openPullRequest: true,
      },
    });
    expect(r.mergeMode).toEqual({
      kind: "verified",
      integrationBranch: "sandbar/staging",
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
          noChecksGraceMs: 500,
        },
      }),
    ).toThrow(/must not exceed/);
  });

  it("refuses a no-checks grace that outlasts the timeout, which would hide the halt", () => {
    // With grace >= timeout the wait always hits the timeout branch first, so
    // "the forge does not build this ref" degrades from a loud halt into a
    // parked cycle — every run, forever.
    expect(() =>
      resolveConfig({
        ...minimal,
        mergeMode: {
          kind: "verified",
          requiredChecks: ["tests"],
          checkTimeoutMs: 60_000,
          noChecksGraceMs: 60_000,
        },
      }),
    ).toThrow(/must be less than/);
  });

  it("refuses an integrationBranch outside sandbar's namespace", () => {
    // It is force-pushed every round; a name collision with a real branch
    // destroys that branch on the first cycle.
    expect(() =>
      resolveConfig({
        ...minimal,
        sourceBranch: "develop",
        mergeMode: {
          kind: "verified",
          requiredChecks: ["tests"],
          integrationBranch: "main",
        },
      }),
    ).toThrow(/must start with 'sandbar\//);
  });
});

// #34 — every host-side path config has to name the repo the run is about.
// #34 — these two used to reach only `fetchIssueStates`'s GraphQL variables and
// `forge-verify`'s `--repo`. They now compose the `--repo` on EVERY tracker
// call and one side of preflight's origin-agreement check, so a malformed one
// addresses a different repository on every call rather than one.
describe("resolveConfig — ghOwner/ghRepo are validated (#34)", () => {
  it("trims, the way sourceBranch is trimmed and for the same reason", () => {
    const r = resolveConfig({ ...minimal, ghOwner: " acme ", ghRepo: "widgets\n" });
    expect(r.ghOwner).toBe("acme");
    expect(r.ghRepo).toBe("widgets");
  });

  // The likeliest slip: gh reads a three-part --repo as HOST/OWNER/REPO, so
  // `ghOwner: "acme/widgets"` sends every call to a host called `acme`.
  it("rejects a slash, which gh would read as a host", () => {
    expect(() => resolveConfig({ ...minimal, ghOwner: "acme/widgets" })).toThrow(
      /ghOwner/,
    );
  });

  it("rejects an interior space", () => {
    expect(() => resolveConfig({ ...minimal, ghRepo: "my widgets" })).toThrow(
      /ghRepo/,
    );
  });

  it("rejects empty and whitespace-only", () => {
    expect(() => resolveConfig({ ...minimal, ghOwner: "" })).toThrow(/ghOwner/);
    expect(() => resolveConfig({ ...minimal, ghRepo: "   " })).toThrow(/ghRepo/);
  });

  it("accepts the punctuation GitHub actually allows", () => {
    const r = resolveConfig({
      ...minimal,
      ghOwner: "acme-corp",
      ghRepo: "my.app_v2-beta",
    });
    expect(r.ghRepo).toBe("my.app_v2-beta");
  });
});

describe("resolveConfig — cwd is absolute (#34)", () => {
  it("resolves a relative cwd against the launch directory", () => {
    const r = resolveConfig({ ...minimal, cwd: "sub/repo" });
    expect(r.cwd).toBe(join(process.cwd(), "sub", "repo"));
  });

  it("leaves an absolute cwd alone", () => {
    const r = resolveConfig({ ...minimal, cwd: "/repos/app" });
    expect(r.cwd).toBe("/repos/app");
  });

  // The reason it has to happen here rather than at each call site: every path
  // sandbar derives from `cwd` is passed to a child as an ARGUMENT while `cwd`
  // itself is that child's working directory, so a relative one is applied
  // twice.
  it("makes a derived worktree path absolute too", () => {
    const r = resolveConfig({ ...minimal, cwd: "sub/repo", workDir: ".sandbar" });
    expect(join(r.cwd, r.workDir)).toBe(
      join(process.cwd(), "sub", "repo", ".sandbar"),
    );
  });
});

// #38 — the credentials are a VALUE, so there is no path to root anywhere and
// no second reader that could disagree about which file it meant.
describe("resolveConfig — env is a record, passed through", () => {
  it("keeps the declared record verbatim", () => {
    const env = { GH_TOKEN: "ghp_x", CLAUDE_CODE_OAUTH_TOKEN: "" };
    const r = resolveConfig({ ...minimal, env });
    expect(r.env).toEqual(env);
  });

  it("does not vary with cwd", () => {
    const here = resolveConfig({ ...minimal, env: { GH_TOKEN: "t" } });
    const elsewhere = resolveConfig({
      ...minimal,
      cwd: "/repos/other",
      env: { GH_TOKEN: "t" },
    });
    expect(here.env).toEqual(elsewhere.env);
  });

  it("defaults to an empty record", () => {
    expect(resolveConfig({ ...minimal }).env).toEqual({});
  });

  // The config is a program, so nothing type-checks it at the host, and #38
  // removed the dotenv parser that used to guarantee the shape. A string here
  // reaches `Object.keys` and exports a dozen single-character variables into
  // every container while the credential check reports GH_TOKEN missing.
  it.each([
    ["a string", "GH_TOKEN=x"],
    ["an array", ["GH_TOKEN=x"]],
    ["null", null],
  ])("refuses %s in place of the record", (_name, value) => {
    expect(() =>
      resolveConfig({ ...minimal, env: value as never }),
    ).toThrow(/config\.env must be an object/);
  });

  it("refuses a non-string value", () => {
    expect(() =>
      resolveConfig({ ...minimal, env: { GH_TOKEN: 42 as never } }),
    ).toThrow(/config\.env\['GH_TOKEN'\] must be a string/);
  });

  it("refuses a key that is not a usable variable name", () => {
    expect(() =>
      resolveConfig({ ...minimal, env: { "GH-TOKEN": "x" } }),
    ).toThrow(/not a usable environment variable name/);
  });
});

// #57 — `sandbar.config.mjs` is a program in a file nothing type-checks, so
// the two-value union is only a union at runtime if this says so. The failure
// mode a validator buys: a misspelt lane compares unequal to "review" and is
// therefore read as auto, so a host that asked for a human's eyes gets none —
// and, being a default rather than a per-issue label, gets none on everything.
describe("resolveConfig — defaultLane (#57)", () => {
  it("accepts both lanes", () => {
    expect(resolveConfig({ ...minimal, defaultLane: "review" }).defaultLane).toBe(
      "review",
    );
    expect(resolveConfig({ ...minimal, defaultLane: "auto" }).defaultLane).toBe(
      "auto",
    );
  });

  it("rejects a value that is neither, naming the field", () => {
    expect(() =>
      // The likeliest slip is borrowing the LABEL's name for the lane.
      resolveConfig({ ...minimal, defaultLane: "auto-land" as never }),
    ).toThrow(/defaultLane/);
    expect(() =>
      resolveConfig({ ...minimal, defaultLane: "auto-land" as never }),
    ).toThrow(SandbarError);
  });

  it("rejects a non-string, which a computed config can produce", () => {
    expect(() =>
      resolveConfig({ ...minimal, defaultLane: true as never }),
    ).toThrow(/defaultLane/);
  });
});
