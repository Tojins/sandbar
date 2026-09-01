// Tests for the NAME → provider mapping (#72): what a config may name, what
// each provider needs a credential for, and which providers a run will invoke.
// All pure — no sandbox, no podman. The argv each provider builds is
// agent-sandbox.test.ts's.

import { describe, expect, it } from "vitest";

import {
  AGENT_PROVIDER_NAMES,
  DEFAULT_AGENT_PROVIDER,
  PROVIDER_CREDENTIALS,
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

  it("asks codex for the API key, as a value rather than a seeded file (#38)", () => {
    expect(PROVIDER_CREDENTIALS.codex.map((c) => c.key)).toEqual([
      "OPENAI_API_KEY",
    ]);
    expect(PROVIDER_CREDENTIALS.codex[0]!.note).toContain("auth.json");
  });
});

describe("requiredAgentProviders", () => {
  it("is just claude for the default routing", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "claude",
        reviewerAgent: "claude",
      }),
    ).toEqual(["claude"]);
  });

  it("adds the provider a role is routed to", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "codex",
        reviewerAgent: "claude",
      }),
    ).toEqual(["claude", "codex"]);
  });

  // The headline configuration of #72 — codex implementer, Opus reviewer —
  // needs both vendors' credentials, and so does its mirror image.
  it("keeps claude even when NO role names it (the merger, #72)", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "codex",
        reviewerAgent: "codex",
      }),
    ).toEqual(["claude", "codex"]);
  });

  it("dedupes when both roles name the same provider", () => {
    expect(
      requiredAgentProviders({
        implementerAgent: "codex",
        reviewerAgent: "codex",
      }).filter((n) => n === "codex").length,
    ).toBe(1);
  });

  // The list feeds a refusal message; an order that moved with the config
  // would read as two different failures for one state.
  it("orders by the canonical list, not by which role named it", () => {
    const a = requiredAgentProviders({
      implementerAgent: "codex",
      reviewerAgent: "claude",
    });
    const b = requiredAgentProviders({
      implementerAgent: "claude",
      reviewerAgent: "codex",
    });
    expect(a).toEqual(b);
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
