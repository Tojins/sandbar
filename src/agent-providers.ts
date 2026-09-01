// Which CLI a role's agent runs (#72) — the NAME → provider mapping, and the
// one place that says what credential each provider needs.
//
// The config already split the MODEL per role (`implementerModelId` /
// `reviewerModelId` / `mergerModelId`); this is the vendor knob beside it. The
// pressure that wants it is the implementer's: a review round is one bounded
// invocation, while an implementer attempt is a long multi-tool session, up to
// `maxImplAttempts` of them per issue and several issues per cycle. Splitting
// across VENDORS buys a second quota pool without weakening the verdict, which
// is why the interesting configuration is a cheaper implementer under a
// Claude/Opus reviewer rather than a cheaper MODEL everywhere — measured
// experience being that a weaker implementer costs more attempts, review rounds
// and merge-phase work than its per-token price returns.
//
// A provider NAME, never a command template. The provider owns its argv exactly
// as `claudeCode` does: a host that could pass a command string would own the
// stream format too, and the format is what the completion watch and the token
// parsers are built on. So this module is a closed set, and adding to it is a
// commit here — `agent-sandbox.ts`'s `codex` is what one costs.
//
// WHY THE SET IS CLOSED AT WHAT SANDBAR CAN ACTUALLY RUN: a name this driver
// cannot build is the silent failure #66 exists to close. `sandbar.config.mjs`
// is a PROGRAM — the value can be computed — so an unknown name is refused by
// `parseAgentProviderName` at config-resolution time, ahead of the lock, rather
// than surfacing as an implementer attempt dying in-container half an hour in.
// (`opencode` is the recorded next one, #72's own §"The opencode + Gemini
// variant". It is absent from the union deliberately: it is not implemented,
// and a config that could NAME it would be refused by the run it was written
// for or, worse, silently fall back to claude.)

import { type AgentProvider, claudeCode, codex } from "./agent-sandbox.js";
import { SandbarError } from "./errors.js";

export const AGENT_PROVIDER_NAMES = ["claude", "codex"] as const;

export type AgentProviderName = (typeof AGENT_PROVIDER_NAMES)[number];

// Default for every role, so every config written before #72 resolves
// unchanged. The reviewer holding the verdict is the role whose default matters
// most: it is the strongest model available, and #72 moves the implementer
// precisely so it does not have to move.
export const DEFAULT_AGENT_PROVIDER: AgentProviderName = "claude";

// A credential a provider will accept, with the note preflight quotes when none
// of them is declared. ANY-OF, not all-of: a provider is credentialled when one
// key carries a value.
export type ProviderCredential = {
  readonly key: string;
  readonly note: string;
};

export const PROVIDER_CREDENTIALS: Record<
  AgentProviderName,
  readonly ProviderCredential[]
> = {
  claude: [
    {
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      note: "Pro/Max/Team/Enterprise subscription; generate with `claude setup-token`",
    },
    {
      key: "ANTHROPIC_API_KEY",
      note: "pay-as-you-go API; takes precedence if both are set",
    },
  ],
  codex: [
    {
      key: "OPENAI_API_KEY",
      note:
        "pay-as-you-go API. A ChatGPT SUBSCRIPTION is not this and will not " +
        "work: its OAuth flow writes `~/.codex/auth.json`, a file inside the " +
        "container that nothing seeds — credentials reach a sandbox as a " +
        "VALUE through `config.env` (#38), never as a path",
    },
  ],
};

// Validated at runtime even though the field is typed, for the reason every
// other config field is: `sandbar.config.mjs` is a program and `.mjs` is not
// type-checked by anything.
export function parseAgentProviderName(
  field: string,
  raw: unknown,
): AgentProviderName {
  if (raw === undefined) return DEFAULT_AGENT_PROVIDER;
  if (
    typeof raw === "string" &&
    (AGENT_PROVIDER_NAMES as readonly string[]).includes(raw)
  ) {
    return raw as AgentProviderName;
  }
  throw new SandbarError(
    `config.${field} must be one of ${AGENT_PROVIDER_NAMES.map((n) => JSON.stringify(n)).join(
      ", ",
    )}, got ${JSON.stringify(raw)}. It names the CLI the role runs; the model ` +
      `it runs stays its own field.`,
  );
}

// Every provider a run will actually invoke, deduped and in a stable order —
// what preflight has to find a credential for.
//
// "claude" is unconditional, and that is a statement about the MERGER rather
// than about the two roles: its resolve agent is hard-coded to claude and is
// out of #72's scope, so an Anthropic credential is something every run needs
// whatever the roles name. Requiring it up front is deliberate over discovering
// it at the moment it is needed: the resolve loop runs mid-merge, on a conflict
// nobody chose the timing of, and a run that has already landed work is the
// worst possible place to learn the credential was never declared.
export function requiredAgentProviders(roles: {
  readonly implementerAgent: AgentProviderName;
  readonly reviewerAgent: AgentProviderName;
}): readonly AgentProviderName[] {
  const named = new Set<AgentProviderName>([
    "claude",
    roles.implementerAgent,
    roles.reviewerAgent,
  ]);
  // Ordered by the canonical list, not by insertion: the set feeds a refusal
  // message, and a message whose lines reorder with the config reads as two
  // different failures.
  return AGENT_PROVIDER_NAMES.filter((n) => named.has(n));
}

export type BuildAgentProviderOptions = {
  // Resume the container's most recent conversation instead of starting a fresh
  // one — `claude --continue`, `codex exec resume --last`. Sound only inside an
  // agent sandbox; see the option's own note on each provider.
  readonly continueSession?: boolean;
};

// The role's CLI and the role's model, together. Every provider takes the model
// id it is given: the id fields keep their existing meaning and are simply
// passed to whichever provider the role names, so a role routed to codex needs
// a codex model id ("gpt-5.6-sol") in the SAME field that held "opus".
export function buildAgentProvider(
  name: AgentProviderName,
  modelId: string,
  options: BuildAgentProviderOptions = {},
): AgentProvider {
  const continueSession = options.continueSession === true;
  switch (name) {
    case "claude":
      return claudeCode(modelId, { continueSession });
    case "codex":
      return codex(modelId, { continueSession });
  }
}
