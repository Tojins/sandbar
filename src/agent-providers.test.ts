// Tests for the NAME → provider mapping (#72): what a config may name, what
// each provider needs a credential for, and which providers a run will invoke.
// All pure — no sandbox, no podman. The argv each provider builds is
// agent-sandbox.test.ts's.

import { describe, expect, it } from "vitest";

import {
  AGENT_PROVIDER_NAMES,
  DEFAULT_AGENT_PROVIDER,
  PROVIDER_CREDENTIALS,
  assertRoleModelIdNamed,
  billingPrecedenceWarnings,
  buildAgentProvider,
  parseAgentProviderName,
  requiredAgentProviders,
} from "./agent-providers.js";
import { SandbarError } from "./errors.js";

describe("parseAgentProviderName", () => {
  // The default is what makes #72 a no-op for every config written before it.
  it("defaults to claude when the field is absent", () => {
    expect(parseAgentProviderName("implementerAgent", undefined)).toBe("claude");
    expect(DEFAULT_AGENT_PROVIDER).toBe("claude");
  });

  it("accepts every name in the canonical list", () => {
    for (const name of AGENT_PROVIDER_NAMES) {
      expect(parseAgentProviderName("implementerAgent", name)).toBe(name);
    }
  });

  // The config is a PROGRAM (#66): the value can be computed, so a name this
  // driver cannot build has to be refused where the config is read rather than
  // spread through and discovered as an implementer dying in-container.
  it("refuses an unknown name, quoting it and listing what is accepted", () => {
    expect(() => parseAgentProviderName("implementerAgent", "opencode")).toThrow(
      SandbarError,
    );
    try {
      parseAgentProviderName("implementerAgent", "opencode");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("config.implementerAgent");
      expect(msg).toContain('"opencode"');
      expect(msg).toContain('"claude"');
      expect(msg).toContain('"codex"');
    }
  });

  // Silently defaulting a non-string would make a config that asked for
  // something indistinguishable from one that asked for nothing.
  it("refuses a non-string rather than falling back to the default", () => {
    for (const bad of [null, 42, {}, ["codex"], true]) {
      expect(() => parseAgentProviderName("reviewerAgent", bad)).toThrow(
        SandbarError,
      );
    }
  });

  it("names the field it was given, so the message points at the right key", () => {
    expect(() => parseAgentProviderName("reviewerAgent", "nope")).toThrow(
      /config\.reviewerAgent/,
    );
  });
});

describe("PROVIDER_CREDENTIALS", () => {
  it("covers every provider name, with at least one key each", () => {
    for (const name of AGENT_PROVIDER_NAMES) {
      expect(PROVIDER_CREDENTIALS[name].length).toBeGreaterThan(0);
      for (const c of PROVIDER_CREDENTIALS[name]) {
        expect(c.key).not.toBe("");
        expect(c.note).not.toBe("");
      }
    }
  });

  // Preserved from the pre-#72 check, which named exactly these two.
  it("keeps both Anthropic credentials as alternatives", () => {
    expect(PROVIDER_CREDENTIALS.claude.map((c) => c.key)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
  });

  // #72 accepted only the API key here and said the subscription "will not
  // work". #73 made it work without moving anything but data: the file's
  // CONTENT is a value like any other credential (#38), so it is a second
  // any-of entry rather than a mount or a path.
  it("accepts either the API key or the ChatGPT session for codex (#73)", () => {
    expect(PROVIDER_CREDENTIALS.codex.map((c) => c.key)).toEqual([
      "OPENAI_API_KEY",
      "CODEX_AUTH_JSON",
    ]);
    const chatgpt = PROVIDER_CREDENTIALS.codex[1]!;
    expect(chatgpt.note).toContain("auth.json");
    // The note is what preflight quotes at an operator with no codex
    // credential, so the two costs #73 named have to be IN it: they are the
    // thin edge of this design and the operator is the one choosing it.
    expect(chatgpt.note).toContain("concurrent");
    expect(chatgpt.note).toContain("codex login");
  });

  // Every provider that accepts two kinds of credential has to say which one
  // its CLI picks, or `billingPrecedenceWarnings` silently has nothing to warn
  // about — the failure it exists to catch is itself silent.
  it("names the preferred key and what each one bills, wherever there is a choice", () => {
    for (const name of AGENT_PROVIDER_NAMES) {
      const creds = PROVIDER_CREDENTIALS[name];
      if (creds.length < 2) continue;
      expect(creds.filter((c) => c.preferred === true)).toHaveLength(1);
      for (const c of creds) expect(c.bills).toBeDefined();
    }
  });
});

describe("billingPrecedenceWarnings", () => {
  const declared =
    (...keys: string[]) =>
    (key: string): string | undefined =>
      keys.includes(key) ? "value" : undefined;

  it("warns when the metered key will beat a declared subscription", () => {
    const [warning, ...rest] = billingPrecedenceWarnings(
      ["codex"],
      declared("OPENAI_API_KEY", "CODEX_AUTH_JSON"),
    );
    expect(rest).toEqual([]);
    expect(warning).toContain("OPENAI_API_KEY");
    expect(warning).toContain("CODEX_AUTH_JSON");
    expect(warning).toContain("codex");
  });

  // The same trap, the other vendor — which is the whole reason this is data
  // over PROVIDER_CREDENTIALS rather than a codex special case.
  it("warns for claude on the same rule", () => {
    expect(
      billingPrecedenceWarnings(
        ["claude"],
        declared("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"),
      ),
    ).toHaveLength(1);
  });

  it("is quiet for either credential alone", () => {
    for (const keys of [
      ["OPENAI_API_KEY"],
      ["CODEX_AUTH_JSON"],
      ["CLAUDE_CODE_OAUTH_TOKEN"],
      ["ANTHROPIC_API_KEY"],
    ]) {
      expect(
        billingPrecedenceWarnings(["claude", "codex"], declared(...keys)),
      ).toEqual([]);
    }
  });

  // It is asked about the providers a run will INVOKE (`requiredAgentProviders`),
  // so a key left in `config.env` from a routing the config no longer names
  // costs nobody anything and says nothing.
  it("says nothing about a provider this run does not route to", () => {
    expect(
      billingPrecedenceWarnings(
        ["claude"],
        declared("OPENAI_API_KEY", "CODEX_AUTH_JSON"),
      ),
    ).toEqual([]);
  });

  // One line per provider, not one for the pair: the two are separate accounts
  // and separate edits to `config.env`.
  it("warns per provider when both are routed and both are doubled", () => {
    expect(
      billingPrecedenceWarnings(
        ["claude", "codex"],
        declared(
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "OPENAI_API_KEY",
          "CODEX_AUTH_JSON",
        ),
      ),
    ).toHaveLength(2);
  });
});

describe("requiredAgentProviders", () => {
  it("is just claude for the default routing", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "claude",
        reviewerAgent: "claude",
        reviewerQualityAgent: "claude",
        mergerAgent: "claude",
      }),
    ).toEqual(["claude"]);
  });

  it("adds the provider a role is routed to", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "codex",
        reviewerAgent: "claude",
        reviewerQualityAgent: "claude",
        mergerAgent: "claude",
      }),
    ).toEqual(["claude", "codex"]);
  });

  // The headline configuration of #72 — codex implementer, Opus reviewer —
  // needs both vendors' credentials, and so does its mirror image. The exact
  // equality is also the dedupe: both roles name codex and it appears once.
  it("does not require claude when no role names it (#74)", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "codex",
        reviewerAgent: "codex",
        reviewerQualityAgent: "codex",
        mergerAgent: "codex",
      }),
    ).toEqual(["codex"]);
  });

  // The quality pass is a routing knob like any other (#121), and the one
  // whose omission is worst: it gates every round, and a provider missing from
  // this set is a sandbox image without that CLI (#75) — a reviewer that
  // cannot start rather than one that answers badly.
  it("adds the provider only the reviewer's quality pass names (#121)", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "claude",
        reviewerAgent: "claude",
        reviewerQualityAgent: "codex",
        mergerAgent: "claude",
      }),
    ).toEqual(["claude", "codex"]);
  });

  // The list feeds a refusal message; an order that moved with the config
  // would read as two different failures for one state.
  it("orders by the canonical list, not by which role named it", () => {
    const a = requiredAgentProviders({
      implementerAgent: "codex",
      reviewerAgent: "claude",
      reviewerQualityAgent: "claude",
      mergerAgent: "claude",
    });
    const b = requiredAgentProviders({
      implementerAgent: "claude",
      reviewerAgent: "codex",
      reviewerQualityAgent: "claude",
      mergerAgent: "claude",
    });
    expect(a).toEqual(b);
  });
});

describe("assertRoleModelIdNamed", () => {
  // The two knobs are independent, which is what lets a config be moved
  // half-way. Half-way runs `codex exec --model opus` on every attempt.
  it("refuses a non-claude provider whose role left the model id unset", () => {
    expect(() =>
      assertRoleModelIdNamed("implementer", "codex", undefined),
    ).toThrow(SandbarError);
    try {
      assertRoleModelIdNamed("implementer", "codex", undefined);
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      // Both halves of the pair, so the reader is not left deducing which
      // field the refusal is about.
      expect(msg).toContain("config.implementerAgent");
      expect(msg).toContain("config.implementerModelId");
    }
  });

  it("names the role it was given", () => {
    expect(() => assertRoleModelIdNamed("reviewer", "codex", undefined)).toThrow(
      /config\.reviewerModelId/,
    );
  });

  // The two reviewer passes are routed independently (#121), so the message
  // has to name the field that actually carries the routing — `reviewerAgent`
  // would send an operator to the wrong line.
  it("names the agent field it was given, not the role's default one", () => {
    expect(() =>
      assertRoleModelIdNamed("reviewer", "codex", undefined, {
        agentField: "reviewerQualityAgent",
        modelField: "reviewerQualityModelId",
      }),
    ).toThrow(/config\.reviewerQualityAgent[\s\S]*config\.reviewerQualityModelId/);
  });

  it("accepts a non-claude provider once the role names an id", () => {
    expect(() =>
      assertRoleModelIdNamed("implementer", "codex", "gpt-5.6-sol"),
    ).not.toThrow();
  });

  // The default only has to be right for the provider it was written for, so
  // claude keeps inheriting it — every config written before #72 is this case.
  it("leaves claude's default alone", () => {
    expect(() =>
      assertRoleModelIdNamed("implementer", "claude", undefined),
    ).not.toThrow();
  });
});

describe("buildAgentProvider", () => {
  it("builds the named CLI, not the named model's usual one", () => {
    expect(buildAgentProvider("claude", "opus").name).toBe("claude-code");
    expect(buildAgentProvider("codex", "gpt-5.6-sol").name).toBe("codex");
  });

  // The model id fields keep their meaning: whatever they hold is passed to
  // whichever provider the role names.
  it("passes the model id through to the provider it built", () => {
    expect(
      buildAgentProvider("codex", "gpt-5.6-sol").buildPrintCommand({
        prompt: "p",
      }).command,
    ).toContain("gpt-5.6-sol");
    expect(
      buildAgentProvider("claude", "opus").buildPrintCommand({ prompt: "p" })
        .command,
    ).toContain("opus");
  });

  it("routes continueSession to each provider's own resume flag", () => {
    expect(
      buildAgentProvider("claude", "opus", {
        continueSession: true,
      }).buildPrintCommand({ prompt: "p" }).command,
    ).toContain("--continue");
    expect(
      buildAgentProvider("codex", "m", {
        continueSession: true,
      }).buildPrintCommand({ prompt: "p" }).command,
    ).toContain("resume --last");
  });

  // Omitted must mean a fresh conversation, not an implicitly resumed one:
  // the nudge is the only caller that wants resume, and every attempt after
  // the first would otherwise inherit the previous attempt's context.
  it("starts a fresh conversation when continueSession is omitted", () => {
    for (const name of AGENT_PROVIDER_NAMES) {
      const cmd = buildAgentProvider(name, "m").buildPrintCommand({
        prompt: "p",
      }).command;
      expect(cmd).not.toContain("--continue");
      expect(cmd).not.toContain("resume");
    }
  });

  it("carries the prompt on stdin for every provider", () => {
    for (const name of AGENT_PROVIDER_NAMES) {
      expect(
        buildAgentProvider(name, "m").buildPrintCommand({ prompt: "the prompt" })
          .stdin,
      ).toBe("the prompt");
    }
  });
});
