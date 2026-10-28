// The outdoor daemon's installation-owned config (#149), the only sandbar
// config outdoor has since Tojins/outdoor#259 removed the checkout-owned copy:
// an explicit `cwd`, the gate stack named by path, and the Claude Code
// settings file supplied from this directory instead of a host hook.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile, splitRoleRouting } from "sandbar";

const cwd = "/home/outdoor/outdoor";
const sandboxImage = "localhost/sandbar:outdoor";

// gate/stack.json is written in sandbar's gateStack schema, so scripts/gate.sh,
// CI and sandbar cannot end up checking different things. The daemon reads its
// containers and steps from origin/main at every gate (Tojins/sandbar#186), so
// a landed stack change reaches the next gate without a restart; the keys
// sandbar has no concept of -- "anchor", "half", "comment" -- are ignored. Its
// `images` are read from the clone here, at import: the image graph is fixed
// at startup, and the play restarts the daemon when it moves.
const stack = JSON.parse(readFileSync(join(cwd, "gate/stack.json"), "utf8"));

// sandbar.env carries credentials and this installation's role routing as
// SANDBAR_* keys (Tojins/sandbar#137); the routing never reaches a sandbox.
const { routing, env: credentials } = splitRoleRouting(
  readEnvFile(new URL("sandbar.env", import.meta.url)),
);
const usesCodex = Object.entries(routing).some(
  ([field, provider]) => field.endsWith("Agent") && provider === "codex",
);

export default {
  cwd,
  ghOwner: "Tojins",
  ghRepo: "outdoor",

  // Whose `ready-for-agent` counts (Tojins/sandbar#136). Every collaborator
  // on this private repo may queue an issue.
  developers: "anyone",

  // 0.60.9 is the first release that reads `egress` (#202); an older driver
  // would drop it in silence. It also reads `databaseCopies` (#201) and
  // `gateStack: { path }` from the source tip (#186), which both use below.
  requiresSandbar: "0.60.9",
  botName: "sandbar",
  botEmail: "sandbar@sda.be",
  uiPort: 7331,

  // Sized for the Hetzner box (Tojins/outdoor#229): three issues in flight, one
  // gate stack at a time, so the gate pods never overlap in memory.
  maxParallelIssues: 3,
  maxConcurrentGates: 1,

  sandboxImage,
  gateStack: { path: "gate/stack.json" },

  // Prod's nightly dump (Tojins/outdoor#781), pushed to this box's drop and
  // imported by sandbar-db-base.timer into a base on the reflink volume
  // (Tojins/sandbar#200, #201). The stack's `db` sibling builds the base, so
  // it has the same server and options as the database a copy replaces.
  databaseCopies: {
    dump: "/srv/sandbar-db/drops/outdoor/outdoor-latest.sql.gz",
    root: "/srv/sandbar-db/installations/outdoor",
    container: "db",
    database: "locallpm",
  },

  // Every sandbox, sibling, gate and resolve container sits behind its own
  // egress proxy (#202). Report mode refuses nothing: each host enforce would
  // refuse lands in the run record as an `egress-refused` event, and those
  // complete this list before it switches to "enforce". GitHub and the model
  // APIs are sandbar's defaults. npm and packagist serve sandbox-prepare.sh's
  // installs; the rest are the integrations the app reaches for real from a
  // sandbox, as outdoor's source names them: Mews demo (configDev.php), the
  // Peppol directory (peppolDirectory.php), VIES and the other GET-only
  // registries (vatRegisters.php; HMRC at dev's sandbox host), and adfinity
  // live for the recording proxy sibling (Tojins/outdoor#785), whose tenant
  // host is a secret, hence the suffix.
  egress: {
    mode: "report",
    allow: [
      "npm",
      "packagist",
      "api.mews-demo.com",
      "directory.peppol.eu",
      "ec.europa.eu",
      "www.uid-wse.admin.ch",
      "wl-api.mf.gov.pl",
      "data.brreg.no",
      "recherche-entreprises.api.gouv.fr",
      "test-api.service.hmrc.gov.uk",
      "kbopub.economie.fgov.be",
      "*.adfinity.app",
    ],
  },

  // The gate images from stack.json, plus the agent's own. The sandbox image
  // is built FROM the php and runner gate images, and the list builds in
  // order, so those tags exist by the time it needs them. Its rebuildOn
  // re-resolves it once per sandbox, so an issue that moves a lockfile gets an
  // agent whose baked /deps match its branch.
  images: [
    ...stack.images,
    {
      tag: sandboxImage,
      containerfile: "Containerfile.sandbar",
      rebuildOn: ["package.json", "package-lock.json", "bower.json", ".bowerrc"],
    },
  ],

  // Claude Code auto-loads CLAUDE.md from the checkout it runs in, so a
  // sandbox agent would otherwise read outdoor's host-machine and prod
  // context. The copied settings file excludes it; claudeMdPath moves the
  // prompt's "Conventions:" anchor onto AGENTS.md. This replaces outdoor's
  // scripts/sandbar-worktree-setup.sh host hook, which wrote the same file.
  claudeMdPath: "AGENTS.md",
  copyToWorktree: [
    {
      from: new URL("files/settings.local.json", import.meta.url),
      to: ".claude/settings.local.json",
    },
  ],

  // Runs in the agent container, after the inSandbox siblings are up and
  // healthy: the worktree deps link, the database prepare and the frontend
  // build+serve (Tojins/outdoor#185, #187). The bound is for a cold composer
  // install plus the build; the default 60s is too tight for it.
  sandboxHooks: {
    sandbox: {
      onSandboxReady: [
        { command: "scripts/sandbox-prepare.sh", timeoutMs: 300_000 },
      ],
    },
  },

  // Project rules on top of sandbar's built-in coding standards, for the
  // implementer and the quality pass; resolved inside the worktree. The
  // verifier leaves standards to the quality pass.
  promptExtensions: {
    implementer: { path: "CODING_STANDARDS.md" },
    reviewerQuality: { path: "CODING_STANDARDS.md" },
  },

  // gate-2 on the composed sha is the only gate on a landing, by decision:
  // Tojins/outdoor#316 deleted tests.yml, so there is no "gate" check to
  // require and verified mode would halt every cycle on `no-checks`.
  mergeMode: { kind: "direct" },

  // Merging main deploys to prod, so nothing lands unreviewed unless the issue
  // opts in with the `auto-land` label. The repo carries the `auto-land`,
  // `needs-review` and `land` labels this needs; sandbar creates none of them.
  defaultLane: "review",

  // The codex credential is the ChatGPT subscription `codex login` writes
  // under this installation's own user; it is read only when a role is routed
  // to codex. Only this one of codex's two credentials is declared: with
  // `OPENAI_API_KEY` also visible the CLI prefers the metered key.
  env: {
    ...credentials,
    ...(usesCodex
      ? { CODEX_AUTH_JSON: readFileSync(join(homedir(), ".codex/auth.json"), "utf8") }
      : {}),
  },
  ...routing,
};
