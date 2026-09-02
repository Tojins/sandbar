// Which CLI a role's agent runs (#72, #74, #75) — the NAME → provider mapping,
// the release-artifact and protocol-version pin the driver installs, and the
// one place that says what credential each provider needs.
//
// The config splits the MODEL per call (`implementerModelId`, correctness
// `reviewerModelId`, `reviewerFollowupModelId`, and `mergerModelId`); this is
// the vendor knob beside it. Both reviewer calls share one provider because a
// resumed session cannot cross vendor CLIs. The pressure that wants the vendor
// knob is the implementer's: a review round is one bounded sequential chain,
// while an implementer attempt is a long multi-tool session, up to
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
//
// WHAT A CREDENTIAL IS ALLOWED TO BE (#73): a value in `config.env`, and that
// held even for the one whose interface is a FILE. codex's ChatGPT
// subscription is `~/.codex/auth.json`, so `CODEX_AUTH_JSON` carries the file's
// CONTENT and the provider materialises it in-container (`CODEX_AUTH_SEED`) —
// the config reads its own host file, sandbar names none, and no host
// credential is mounted writable into a sandbox (#38). Adding the key was
// otherwise a data change: `PROVIDER_CREDENTIALS` was already any-of, so a
// second accepted key needed no new mechanism, and an older driver handed a
// config declaring only it refuses the run LOUDLY (it finds no accepted codex
// credential) rather than silently — which is why this needed no
// `requiresSandbar` move, unlike a config FIELD (#66).
//
// What the second key DID need is `billingPrecedenceWarnings`: any-of stops
// being the whole story once two accepted keys bill differently and the CLI
// picks between them by itself.

import { type AgentProvider, claudeCode, codex } from "./agent-sandbox.js";
import { SandbarError } from "./errors.js";

export const AGENT_PROVIDER_NAMES = ["claude", "codex"] as const;

export type AgentProviderName = (typeof AGENT_PROVIDER_NAMES)[number];

// Driver-owned because these binaries implement the provider protocol this
// release parses. A routed role must not inherit whichever CLI a host image (or
// an old branch's image recipe) happened to bake (#75).
export type AgentArtifact = {
  // Claude publishes libc-specific dynamic binaries; Codex's musl release is
  // static. The augment recipe chooses the former inside the base image.
  readonly variant: "static" | "glibc" | "musl";
  readonly url: string;
  readonly sha256: string;
  readonly archive?: true;
};

export type AgentProviderPackage = {
  readonly version: string;
  readonly artifacts: Readonly<Record<"x64" | "arm64", readonly AgentArtifact[]>>;
};

// Both standalone releases and every architecture's digest are pinned here;
// CDN metadata is not trusted at download time. Codex's pin is additionally
// co-versioned with parseCodexJsonLine: its
// JSONL dialect is load-bearing under parsedOutputOnly, so a parser change and
// a CLI change belong to the same driver release.
export const AGENT_PROVIDER_PACKAGES: Readonly<
  Record<AgentProviderName, AgentProviderPackage>
> = {
  claude: {
    version: "2.1.257",
    artifacts: {
      x64: [
        {
          variant: "glibc",
          url: "https://downloads.claude.ai/claude-code-releases/2.1.257/linux-x64/claude",
          sha256: "9a64bda9d8722a1fa05bef9a5961d07e0331b99597eda9e2f6a732f3a0ff7f05",
        },
        {
          variant: "musl",
          url: "https://downloads.claude.ai/claude-code-releases/2.1.257/linux-x64-musl/claude",
          sha256: "51e08d1948c31d4ab386cd744ba633739236ac0cbedded05d0ef07f2d60e950e",
        },
      ],
      arm64: [
        {
          variant: "glibc",
          url: "https://downloads.claude.ai/claude-code-releases/2.1.257/linux-arm64/claude",
          sha256: "22f7d48f17193952c3c2d0b8bf2f31db2cd08fd5fb09a374fa321496b711d017",
        },
        {
          variant: "musl",
          url: "https://downloads.claude.ai/claude-code-releases/2.1.257/linux-arm64-musl/claude",
          sha256: "c5c088fb49fb514f8df5af9840731bfbe38f74a2d85f21bbd233a6e7b6b8d2e2",
        },
      ],
    },
  },
  codex: {
    version: "0.152.0",
    artifacts: {
      x64: [{
        variant: "static",
        url: "https://github.com/openai/codex/releases/download/rust-v0.152.0/codex-x86_64-unknown-linux-musl.tar.gz",
        sha256: "05f942d3d3c5b5acd9edad56ce2797b6fe72dbb1462b24e5c9bf7dcec9a28a11",
        archive: true,
      }],
      arm64: [{
        variant: "static",
        url: "https://github.com/openai/codex/releases/download/rust-v0.152.0/codex-aarch64-unknown-linux-musl.tar.gz",
        sha256: "37da6b486503c8a42cc4604d2a3d80d388df896dd251e9225f4f3d49b08c2e8c",
        archive: true,
      }],
    },
  },
};

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
  // What spending this credential BILLS (#73). Only the distinction the
  // warning below turns on: `subscription` is a flat plan the operator pays for
  // whether a run uses it or not, `api` is metered per token.
  readonly bills?: "api" | "subscription";
  // The key this provider picks when more than one of its credentials is
  // visible at once. At most one per provider carries it, and it is the CLI's
  // own behaviour being recorded, not a preference sandbar imposes — nothing
  // here reorders anything, because the choice is made inside the container by
  // a program sandbar does not control.
  readonly preferred?: true;
};

export const PROVIDER_CREDENTIALS: Record<
  AgentProviderName,
  readonly ProviderCredential[]
> = {
  claude: [
    {
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      note: "Pro/Max/Team/Enterprise subscription; generate with `claude setup-token`",
      bills: "subscription",
    },
    {
      key: "ANTHROPIC_API_KEY",
      note: "pay-as-you-go API; takes precedence if both are set",
      bills: "api",
      preferred: true,
    },
  ],
  codex: [
    {
      key: "OPENAI_API_KEY",
      note: "pay-as-you-go API; takes precedence if both are set",
      bills: "api",
      preferred: true,
    },
    {
      key: "CODEX_AUTH_JSON",
      note:
        "ChatGPT Plus/Pro/Business subscription — the verbatim CONTENT of the " +
        "`~/.codex/auth.json` (`$CODEX_HOME`) that `codex login` wrote on a " +
        "host, as a value (#38, #73): `readFileSync(join(homedir(), " +
        '".codex/auth.json"), "utf8")` in the config, which is a program. ' +
        "The provider writes it into each sandbox's own `$HOME` on first use " +
        "and never over a file already there, so in-container refreshes are " +
        "kept. Two costs to have chosen knowingly: parallel sandboxes hold " +
        "concurrent copies of one credential, which OpenAI's CI/CD guidance " +
        "advises against, and a refresh can rotate the token away from the " +
        "host's copy — after which a later series needs `codex login` again",
      bills: "subscription",
    },
  ],
};

// The trap that a provider accepting BOTH kinds of credential creates, and the
// only thing `bills`/`preferred` exist for (#73).
//
// A CLI handed a subscription credential and a metered key picks one of them,
// inside the container, by its own rule — codex prefers `OPENAI_API_KEY` over a
// ChatGPT session, claude prefers `ANTHROPIC_API_KEY` over an OAuth token. Both
// configurations RUN, which is why this is a warning and not a refusal, and
// both are silent: the sub is charged flat whether or not anything used it, so
// the whole symptom is an API bill that arrives weeks later for tokens a plan
// already covered. That asymmetry is the argument for warning at all — declared
// together, the metered key wins every time and the subscription is paid for
// twice.
//
// Data-driven over every provider rather than written for codex, because it is
// the same trap in both vendors and the facts it needs were already in the
// notes above. It reads the same resolved view of `config.env` the credential
// check does, so a key declared empty and absent from the host environment is
// not "declared" here either.
export function billingPrecedenceWarnings(
  providers: readonly AgentProviderName[],
  env: (key: string) => string | undefined,
): readonly string[] {
  const out: string[] = [];
  for (const provider of providers) {
    const declared = PROVIDER_CREDENTIALS[provider].filter((c) => !!env(c.key));
    const winner = declared.find((c) => c.preferred === true);
    if (winner === undefined || winner.bills !== "api") continue;
    const unused = declared.filter((c) => c.bills === "subscription");
    if (unused.length === 0) continue;
    const unusedKeys = unused.map((c) => c.key).join(" and ");
    out.push(
      `WARNING: \`config.env\` declares ${winner.key} as well as ${unusedKeys} ` +
        `for ${provider}. ${provider} prefers ${winner.key} when both are ` +
        "visible, so this run bills the metered API while the subscription " +
        `${unusedKeys} authenticates goes unspent — a cost that shows up on a ` +
        `bill and nowhere in a run. Drop ${winner.key} from \`config.env\` to ` +
        "spend the subscription instead.",
    );
  }
  return out;
}

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
// All three roles participate: no provider is unconditional. Requiring the
// routed set up front is deliberate over discovering a missing credential in
// the resolve loop, after a run may already have landed work.
export function requiredAgentProviders(roles: {
  readonly implementerAgent: AgentProviderName;
  readonly reviewerAgent: AgentProviderName;
  readonly mergerAgent: AgentProviderName;
}): readonly AgentProviderName[] {
  const named = new Set<AgentProviderName>([
    roles.implementerAgent,
    roles.reviewerAgent,
    roles.mergerAgent,
  ]);
  // Ordered by the canonical list, not by insertion: the set feeds a refusal
  // message, and a message whose lines reorder with the config reads as two
  // different failures.
  return AGENT_PROVIDER_NAMES.filter((n) => named.has(n));
}

// The two knobs are independent, and that independence is exactly what lets a
// config be half-moved: a role routed away from claude while its model id keeps
// the default it was given for claude ("opus") runs `codex exec --model opus`
// every attempt. The model-id fields cannot be validated in general — the
// defaults are deliberately version-agnostic ALIASES, and no list of a vendor's
// ids would stay true — but a model field owned by a non-claude role and left
// unset is decidable without knowing any vendor's id space, because the value it
// would inherit is a claude alias this repo wrote down.
//
// Refused here rather than survived: the failure is bounded (codex exits
// non-zero on an id it does not know, so HARD-ERROR and NEEDS-HUMAN in three
// attempts) but it is a whole issue's sandbox bringups spent on a field the
// config could have been asked about ahead of the lock — and the same
// half-moved config is what `sandbar.config.mjs`'s own comment tells a human to
// hold by hand across three edits. `modelField` names the particular call for
// diagnostics; callers keep it paired with `role`, and config resolution
// asserts the reviewer role twice because it owns two independently named ids.
export function assertRoleModelIdNamed(
  role: "implementer" | "reviewer" | "merger",
  provider: AgentProviderName,
  rawModelId: string | undefined,
  modelField: string = `${role}ModelId`,
): void {
  if (provider === "claude" || rawModelId !== undefined) return;
  throw new SandbarError(
    `config.${role}Agent is ${JSON.stringify(provider)}, so config.${modelField} ` +
      `must name a ${provider} model. Left unset it defaults to a claude alias, ` +
      `which ${provider} would be asked for on every attempt.`,
  );
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
