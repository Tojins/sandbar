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
  DEFAULT_UI_PROTOTYPE_CHECK,
  DEFAULT_REVIEWER_MODEL_ID,
  DEFAULT_REVIEWER_QUALITY_MODEL_ID,
  DEFAULT_MERGER_MODEL_ID,
  DEFAULT_SOURCE_BRANCH,
  DEFAULT_WORK_DIR,
  DEFAULT_LABELS,
  resolveConfig,
  type RunConfig,
} from "./config.js";
import { sandbarVersion } from "./version.js";

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
    expect(r.uiPrototypeCheck).toBe(DEFAULT_UI_PROTOTYPE_CHECK);
    expect(r.uiCheckModelId).toBe(DEFAULT_IMPLEMENTER_MODEL_ID);
    expect(r.reviewerModelId).toBe(DEFAULT_REVIEWER_MODEL_ID);
    expect(r.reviewerQualityModelId).toBe(DEFAULT_REVIEWER_QUALITY_MODEL_ID);
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
    expect(r.maxParallelIssues).toBe(3);
    // The auto lane (#57): the pre-lane behaviour, so a host that never sets
    // this — and this repo — is routed exactly as it was before lanes existed.
    expect(r.defaultLane).toBe(DEFAULT_LANE);
    expect(r.defaultLane).toBe("auto");
    expect(r.promptExtensions).toEqual({});
    expect(r.uiCheckAgent).toBe(r.implementerAgent);
  });

  it("refuses the removed codingStandardsPath by name", () => {
    expect(() => resolveConfig({ ...minimal, codingStandardsPath: "STANDARDS.md" } as RunConfig))
      .toThrow(/config\.codingStandardsPath.*config\.promptExtensions/);
  });

  it("accepts the explicit prompt-extension union", () => {
    expect(resolveConfig({
      ...minimal,
      promptExtensions: { implementer: { path: "RULES.md" }, merger: { text: "merge rule" } },
    }).promptExtensions).toEqual({
      implementer: { path: "RULES.md" }, merger: { text: "merge rule" },
    });
  });

  it.each([
    ["a non-object collection", "merger", /must be an object keyed by agent role/],
    ["an array collection", [], /must be an object keyed by agent role/],
    ["an unknown role", { operator: { text: "x" } }, /unknown role "operator"/],
    ["a non-object role value", { merger: "x" }, /merger must be \{ text \} or \{ path \}/],
    ["an array role value", { merger: [] }, /merger must be \{ text \} or \{ path \}/],
    ["both union fields", { merger: { text: "x", path: "RULES.md" } }, /exactly \{ text: string \} or \{ path: string \}/],
    ["an extra field", { merger: { text: "x", extra: true } }, /exactly \{ text: string \} or \{ path: string \}/],
    ["a non-string text", { merger: { text: 1 } }, /exactly \{ text: string \} or \{ path: string \}/],
    ["a non-string path", { merger: { path: false } }, /exactly \{ text: string \} or \{ path: string \}/],
  ])("refuses %s in promptExtensions", (_label, promptExtensions, message) => {
    expect(() => resolveConfig({ ...minimal, promptExtensions } as RunConfig))
      .toThrow(message);
  });

  it("defaults the two per-issue budgets to the same number (#71)", () => {
    // Not decoration: on a green-gate branch every attempt ends in a reviewer
    // run, so the effective budget is min(attempts, rounds). Equal is what
    // keeps every attempt reachable AND parks an exhausted issue as
    // NEEDS-HUMAN-REVIEW rather than reviewer-blocked. 8 is #71's number, from
    // #66's five-round exhaustion on a converging branch.
    expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(8);
    expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(DEFAULT_MAX_IMPL_ATTEMPTS);
    const r = resolveConfig(minimal);
    expect(r.maxReviewRounds).toBe(r.maxImplAttempts);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses invalid maxParallelIssues %s (#87)",
    (maxParallelIssues) => {
      expect(() => resolveConfig({ ...minimal, maxParallelIssues })).toThrow(
        /config\.maxParallelIssues.*positive integer/,
      );
    },
  );

  // The comparison itself is `requires-sandbar.test.ts`'s, which drives both
  // versions directly. What is asserted HERE is only what wiring it into
  // `resolveConfig` decides: that an absent floor checks nothing, that a
  // satisfiable one is kept, and that an unsatisfiable one is refused BEFORE
  // any other field is interpreted. The floors are written against the real
  // driver version, since that is what the wiring reads.
  describe("requiresSandbar (#66)", () => {
    it("is unset by default and checks nothing", () => {
      expect(resolveConfig(minimal).requiresSandbar).toBeUndefined();
    });

    it("passes a driver at or above the floor, and keeps the value", () => {
      const r = resolveConfig({ ...minimal, requiresSandbar: "0.0.1" });
      expect(r.requiresSandbar).toBe("0.0.1");
    });

    it("refuses a driver below the floor, naming both versions", () => {
      expect(() =>
        resolveConfig({ ...minimal, requiresSandbar: "9999.0.0" }),
      ).toThrow(
        new RegExp(
          `requires sandbar 9999\\.0\\.0 or newer.*driver is ${sandbarVersion()}`,
          "s",
        ),
      );
    });

    // Ahead of every other field: a config this driver cannot read must not
    // first be complained about one field at a time.
    it("is checked before the rest of the config is interpreted", () => {
      expect(() =>
        resolveConfig({
          ...minimal,
          requiresSandbar: "9999.0.0",
          ghOwner: "not/a/name",
        } as RunConfig),
      ).toThrow(/requires sandbar 9999\.0\.0 or newer/);
    });
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

  it("defaults every agent call to the version-agnostic opus alias", () => {
    const r = resolveConfig(minimal);
    expect(r.implementerModelId).toBe("opus");
    expect(r.reviewerModelId).toBe("opus");
    expect(r.reviewerQualityModelId).toBe("opus");
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

  it("defaults UI-check routing to the implementer and can disable the call (#126)", () => {
    const inherited = resolveConfig({
      ...minimal,
      implementerAgent: "codex",
      implementerModelId: "gpt-5.6-sol",
    });
    expect(inherited.uiPrototypeCheck).toBe(true);
    expect(inherited.uiCheckAgent).toBe("codex");
    expect(inherited.uiCheckModelId).toBe("gpt-5.6-sol");

    const split = resolveConfig({
      ...minimal,
      uiCheckAgent: "codex",
      uiCheckModelId: "gpt-5.6-sol",
      uiCheckEffort: "low",
    });
    expect(split.uiCheckAgent).toBe("codex");
    expect(split.uiCheckModelId).toBe("gpt-5.6-sol");
    expect(split.uiCheckEffort).toBe("low");
    expect(resolveConfig({ ...minimal, uiPrototypeCheck: false }).uiPrototypeCheck)
      .toBe(false);
  });

  it("validates UI-check fields only where invocation requires it (#126)", () => {
    expect(() =>
      resolveConfig({ ...minimal, uiPrototypeCheck: "yes" as never }),
    ).toThrow(/config\.uiPrototypeCheck must be a boolean/);
    expect(() =>
      resolveConfig({ ...minimal, uiCheckAgent: "codex" }),
    ).toThrow(/config\.uiCheckAgent is "codex"[\s\S]*config\.uiCheckModelId/);
    expect(() =>
      resolveConfig({
        ...minimal,
        uiPrototypeCheck: false,
        uiCheckAgent: "codex",
      }),
    ).not.toThrow();
  });

  // #72 — the vendor knob beside the tiering one. Defaulting both to "claude"
  // is what makes the field a no-op for every config written before it.
  it("defaults all agent roles to claude (#72, #74)", () => {
    const r = resolveConfig(minimal);
    expect(r.implementerAgent).toBe("claude");
    expect(r.reviewerAgent).toBe("claude");
    expect(r.mergerAgent).toBe("claude");
  });

  // #72's headline configuration: a cheaper implementer under an Opus reviewer.
  it("routes each role's provider independently of the other's (#72)", () => {
    const r = resolveConfig({
      ...minimal,
      implementerAgent: "codex",
      implementerModelId: "gpt-5.6-sol",
    });
    expect(r.implementerAgent).toBe("codex");
    expect(r.implementerModelId).toBe("gpt-5.6-sol");
    // The reviewer holds the verdict and is untouched by the implementer's
    // routing — there is no global provider knob that could bleed across roles.
    expect(r.reviewerAgent).toBe("claude");
    expect(r.reviewerModelId).toBe("opus");
  });

  it("routes the merger independently (#74)", () => {
    const r = resolveConfig({
      ...minimal,
      mergerAgent: "codex",
      mergerModelId: "gpt-5.6-sol",
    });
    expect(r.mergerAgent).toBe("codex");
    expect(r.mergerModelId).toBe("gpt-5.6-sol");
    expect(r.implementerAgent).toBe("claude");
    expect(r.reviewerAgent).toBe("claude");
  });

  // The third per-call knob (#130). Passed through per role and otherwise
  // ABSENT — not defaulted, not normalised — because unset means "the CLI's
  // own default", and a driver default here would be the dotfile-shaped
  // invisible setting the field exists to replace.
  it("passes each role's reasoning effort through, and leaves unset ones absent (#130)", () => {
    const r = resolveConfig({
      ...minimal,
      implementerEffort: "high",
      uiCheckEffort: "medium",
      reviewerQualityEffort: "high",
      mergerEffort: "xhigh",
    });
    expect(r.implementerEffort).toBe("high");
    expect(r.uiCheckEffort).toBe("medium");
    expect(r.reviewerQualityEffort).toBe("high");
    expect(r.mergerEffort).toBe("xhigh");
    expect(r.reviewerEffort).toBeUndefined();
    const none = resolveConfig(minimal);
    expect(none.implementerEffort).toBeUndefined();
    expect(none.uiCheckEffort).toBeUndefined();
    expect(none.reviewerEffort).toBeUndefined();
    expect(none.reviewerQualityEffort).toBeUndefined();
    expect(none.mergerEffort).toBeUndefined();
  });

  // Shape only: the level set is the CLI's to refuse. An empty string would
  // render as `--effort ` and a number as a flag the CLI never sees the type
  // of, so both are refused ahead of the lock, naming the field.
  it("refuses an empty or non-string reasoning effort (#130)", () => {
    expect(() => resolveConfig({ ...minimal, implementerEffort: "" })).toThrow(
      /config\.implementerEffort/,
    );
    expect(() => resolveConfig({ ...minimal, uiCheckEffort: "" })).toThrow(
      /config\.uiCheckEffort/,
    );
    expect(() =>
      resolveConfig({ ...minimal, reviewerEffort: 3 as never }),
    ).toThrow(/config\.reviewerEffort/);
    expect(() =>
      resolveConfig({ ...minimal, reviewerQualityEffort: null as never }),
    ).toThrow(/config\.reviewerQualityEffort/);
    expect(() => resolveConfig({ ...minimal, mergerEffort: "" })).toThrow(
      /config\.mergerEffort/,
    );
  });

  // The config is a PROGRAM (#66): the value can be computed, and a field
  // written for a newer sandbar is otherwise spread through unread. `opencode`
  // is the specific name worth pinning — #72 records it as the next provider,
  // so it is the one an operator is most likely to write early.
  it("refuses a provider name this driver cannot build (#72)", () => {
    expect(() =>
      resolveConfig({ ...minimal, implementerAgent: "opencode" as never }),
    ).toThrow(/implementerAgent/);
    expect(() =>
      resolveConfig({ ...minimal, reviewerAgent: "gpt" as never }),
    ).toThrow(/reviewerAgent/);
  });

  // The vendor knob and the tiering knob are independent, so a config can be
  // moved half-way — and half-way is `codex exec --model opus` on every
  // attempt, three sandbox bringups before a human sees NEEDS-HUMAN. Decidable
  // ahead of the lock because the id it would inherit is a claude alias this
  // repo wrote down; the ids themselves stay unvalidated, being aliases.
  it("refuses a role routed off claude whose model id is still unset (#72)", () => {
    expect(() =>
      resolveConfig({ ...minimal, implementerAgent: "codex" }),
    ).toThrow(/implementerModelId/);
    expect(() => resolveConfig({ ...minimal, reviewerAgent: "codex" })).toThrow(
      /reviewerModelId/,
    );
    expect(() => resolveConfig({ ...minimal, mergerAgent: "codex" })).toThrow(
      /mergerModelId/,
    );
    // The quality pass inherits `reviewerAgent` when it names no CLI of its
    // own (#121), so routing the reviewer role obliges BOTH ids — and the
    // message names the field the operator WROTE, not the inherited one they
    // would go looking for and not find.
    expect(() =>
      resolveConfig({
        ...minimal,
        reviewerAgent: "codex",
        reviewerModelId: "gpt-5.6-sol",
      }),
    ).toThrow(/config\.reviewerAgent is "codex"[\s\S]*config\.reviewerQualityModelId/);
    expect(() =>
      resolveConfig({
        ...minimal,
        reviewerAgent: "codex",
        reviewerModelId: "gpt-5.6-sol",
        reviewerQualityModelId: "gpt-5.6-sol",
      }),
    ).not.toThrow();
  });

  // The two passes are independently routed since #121, so the assertion is
  // per PASS against that pass's own provider: a quality pass on codex under a
  // claude correctness pass is a half-moved config the correctness id says
  // nothing about.
  it("refuses a quality pass routed off claude whose own model id is unset (#121)", () => {
    expect(() =>
      resolveConfig({ ...minimal, reviewerQualityAgent: "codex" }),
    ).toThrow(/config\.reviewerQualityAgent is "codex"/);
    expect(() =>
      resolveConfig({ ...minimal, reviewerQualityAgent: "codex" }),
    ).toThrow(/config\.reviewerQualityModelId/);
    expect(() =>
      resolveConfig({
        ...minimal,
        reviewerQualityAgent: "codex",
        reviewerQualityModelId: "gpt-5.6-sol",
      }),
    ).not.toThrow();
    // ...and the correctness pass stays on its own claude default while it does.
    expect(
      resolveConfig({
        ...minimal,
        reviewerQualityAgent: "codex",
        reviewerQualityModelId: "gpt-5.6-sol",
      }).reviewerModelId,
    ).toBe("opus");
  });

  it("defaults the quality pass's CLI to the reviewer's own (#121)", () => {
    expect(resolveConfig(minimal).reviewerQualityAgent).toBe("claude");
    expect(
      resolveConfig({
        ...minimal,
        reviewerAgent: "codex",
        reviewerModelId: "gpt-5.6-sol",
        reviewerQualityModelId: "gpt-5.6-sol",
      }).reviewerQualityAgent,
    ).toBe("codex");
  });

  // A renamed field is #66's silent failure by construction: the config is
  // IMPORTED, so the old spelling would be spread through and never read while
  // the pass ran on the default model.
  it("refuses the pre-#121 spelling by name rather than ignoring it", () => {
    expect(() =>
      resolveConfig({
        ...minimal,
        reviewerFollowupModelId: "claude-sonnet-4-6",
      } as never),
    ).toThrow(/reviewerFollowupModelId/);
    expect(() =>
      resolveConfig({
        ...minimal,
        reviewerFollowupModelId: "claude-sonnet-4-6",
      } as never),
    ).toThrow(/reviewerQualityModelId/);
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

  // Before #66 everything that was not "direct" was READ as verified, so a
  // `kind` a newer sandbar defines — or a typo — silently ran the forge
  // verification protocol against a config that never described one.
  it("refuses a kind it does not recognise, rather than reading it as verified", () => {
    for (const kind of ["Verified", "queued", ""]) {
      expect(() =>
        resolveConfig({
          ...minimal,
          mergeMode: { kind } as unknown as RunConfig["mergeMode"],
        }),
      ).toThrow(/must be "direct" or "verified"/);
    }
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
    // #58's second shape is reaped by the same preflight glob, so it is
    // reserved on the same grounds.
    { label: "inside the reaped chunk-branch namespace", branch: "sandbar/chunk-x" },
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
