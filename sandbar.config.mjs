// Sandbar operating on sandbar (#39).
//
// Since #66 this repo is worked on by a PINNED sandbar, exactly as a consumer's
// would be: `sandbar.pin` names a tag, `npm run sandbar` installs it into
// `.sandbar/driver/` and launches the daemon once. The daemon itself polls for
// new work (#133); Ctrl-C and another launch reload this config.
//
// THIS FILE is the residual, and it is deliberate rather than overlooked: the
// config resolves against the process cwd and `sandbar.env` against this file's
// own `import.meta.url`, so both stay in the operator's checkout and a run's
// gate stack is still whatever is saved here. Two things follow, and the second
// is a real cost rather than a footnote. `requiresSandbar` below is the guard on
// the version seam — a driver older than the field says refuses the run by name
// instead of silently ignoring what it cannot read — while #69's opening line
// names this path and whether its tree is dirty. And nothing updates this file
// any more: the launcher's `git pull` went with #66, so a gate-stack change that
// lands on main judges nothing until a human pulls it here. That is the deliberate trade — a
// series can run while the operator holds local commits — and preflight warns
// when the commits this checkout is missing include ones that touch this file,
// so it is reported rather than silent. What is gone is the ORCHESTRATOR and its
// prompts being a function of the same tree.
//
// The import is from the installed driver rather than `./dist/`, for that same
// reason: there is no build in this checkout during a series, and `readEnvFile`
// should be the one from the version being run. `npm run driver` installs it
// without starting a series, which is what the hand paths (`sandbar gate`, or
// just loading this file) need.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER_ENTRY = new URL(
  ".sandbar/driver/node_modules/sandbar/dist/index.js",
  import.meta.url,
);
if (!existsSync(DRIVER_ENTRY)) {
  // `fileURLToPath`, not `.pathname`: a URL keeps its path percent-encoded, so
  // a checkout under a directory whose name has a space would name itself
  // `/home/op/my%20repo/...` — not a path the operator can paste anywhere.
  throw new Error(
    `No pinned sandbar driver at ${fileURLToPath(DRIVER_ENTRY)}. Run ` +
      "`npm run driver` to install the release `sandbar.pin` names " +
      "(`npm run sandbar` does it itself). This file is a program and imports " +
      "the driver it is run by (#66).",
  );
}
const { readEnvFile, splitRoleRouting } = await import(DRIVER_ENTRY.href);

// `sandbar.env` holds two kinds of thing since #137: credentials, which cross
// into every sandbox, and this installation's per-role routing — the fifteen
// `SANDBAR_<ROLE>_{AGENT,MODEL_ID,EFFORT}` keys — which must NOT. The split is
// the driver's, so the reserved keys have one spelling and cannot leak; what
// is left is the sandbox allowlist, and `routing` is spread over the defaults
// at the bottom of this file. The committed config therefore carries no
// vendor choice of its own: each box that runs this repo names its agents in
// its own gitignored file, and a checkout with no routing keys runs every
// role on the claude/opus defaults.
const { routing, env: credentials } = splitRoleRouting(
  readEnvFile(new URL("sandbar.env", import.meta.url)),
);

// One image serves both roles — the agent sandbox (`--user 1000:1000
// --userns=keep-id`) and the gate runner (a pod member, where keep-id is
// impossible and container root is what maps back to the invoking user). The
// driver's augmentation supplies the sandbox's uid-1000 agent; the base image
// leaves its default USER as root for the gate runner.
const IMAGE = "localhost/sandbar-agent:latest";

// The gate runner talks to the host's podman over this (#48). The config is a
// program, so the uid is derived rather than written down — the path is
// rootless podman's, and a hardcoded one would be wrong on any other account.
// If `podman.socket` is not active this source does not exist, and until #51
// that meant a bringup failure on an `attempt` container, i.e. a gate RED
// blaming the branch for host state. Preflight now stats every absolute
// `mounts[].hostPath` and refuses the run naming this path and `runner`, so
// the operator is sent to `systemctl --user enable --now podman.socket`
// instead of three issues being parked as `agent-stuck`.
const PODMAN_SOCKET = `/run/user/${process.getuid()}/podman/podman.sock`;

export default {
  ghOwner: "Tojins",
  ghRepo: "sandbar",
  developers: ["Tojins"],
  sandboxImage: IMAGE,

  // The oldest sandbar that can read this file (#66). Since the driver is
  // pinned and this file is not, the two come from different commits by
  // construction, and "config newer than driver" is the routine direction: a
  // field landed here for a version the pin has not moved to yet would
  // otherwise be dropped in silence, gate steps included. Not the same number
  // as `sandbar.pin` and not required to be — the pin is what runs, this is the
  // floor below which it must not — but raise it in the same commit as anything
  // this file starts asking a newer sandbar for.
  //
  // It is 0.37.11, the first TAGGED release that reads `developers` (#136)
  // and exports `splitRoleRouting` (#137, exported since 0.37.5). A driver
  // older than that would spread `developers` through unread and — since the
  // routing below is no longer written into this file — run every role on the
  // claude/opus defaults while the env file named codex: the exact silent
  // failure the floor exists to refuse. Earlier floors, each subsumed by the
  // next: 0.23.0 for the codex routing and its subscription credential (#72,
  // #73), 0.24.6 for the augmented sandbox image (#75), 0.28.1 for the
  // two-pass reviewer's per-pass fields (#121), 0.32.5 for the `*Effort`
  // fields (#130). It moves when this file starts asking a newer sandbar for
  // something, not when the pin does.
  requiresSandbar: "0.37.11",

  botName: "sandbar",
  botEmail: "demanthomas+sandbar@gmail.com",

  // The working rules every agent committing here follows (bump the version in
  // the same commit, and whatever joins it). Named outright so the prompt
  // builders emit `Context: @AGENTS.md` in the project anchor, rather than
  // leaving the agent to follow the import out of CLAUDE.md — two routes to one
  // file, neither load-bearing alone. The default is `CONTEXT.md`, which this
  // repo does not have and which is silently dropped, so this line costs
  // nothing it was not already spending.
  contextMdPath: "AGENTS.md",

  promptExtensions: {
    merger: {
      text: "When a merge conflicts on `version`, the merged value is one patch bump above the higher of the two sides — never either side's own — and `package-lock.json` carries the same value.",
    },
  },

  sandboxHooks: {
    host: {
      // `node_modules` is installed on the HOST, into the gated worktree, and
      // reaches the sandbox and the gate runner through the bind mount — which
      // is why the image is glibc-based and pinned to the host's node major
      // (vitest's esbuild/rollup binaries are the host's linux-x64-gnu builds).
      //
      // The explicit bound is not decoration: the hook default is 60s and a
      // cold-cache `npm ci` runs close enough to it that the failure would look
      // like a flaky sandbox rather than a timeout.
      //
      // It runs once, when the worktree is created — which is enough because a
      // branch that changes the lockfile updates `node_modules` in that same
      // worktree from inside the sandbox, and the gate mounts the worktree. So
      // the image bakes no dependency of the repo and needs no `rebuildOn`
      // (#37): there is no baked lockfile for a branch to make stale.
      //
      // `--no-audit` because the audit is a SECOND service on the setup path and
      // nothing here reads its answer: the gate never runs `npm audit`, so no
      // verdict depends on it, while a stalled advisory lookup is charged to
      // every issue in the plan. Measured on 2026-09-04, warm cache: the install
      // itself is 0.8s, the bulk-advisory POST answered once in 35s and then
      // twice not at all inside 90s, and `npm audit` on this lockfile ran
      // 100s–180s+ at 0.2s of CPU. Two worktrees paid 302s each for it that
      // morning against this 600s bound, after two days flat at ~2.5s.
      onWorktreeReady: [{ command: "npm ci --no-audit", timeoutMs: 600_000 }],
    },
  },

  // What it takes to produce a verdict about a commit here: one container,
  // three steps. `hold: true` because the image has no long-running process of
  // its own; default `lifecycle: "attempt"` because it mounts the worktree and
  // runs the branch's code, so it is recreated every gate run.
  //
  // The runner drives the HOST's podman through the socket below (#48), which
  // is what lets the podman-backed tests run here at all — they resolve their
  // `describe.runIf` at collection time against `podman image exists`, so
  // without one they used to skip ~35 tests and leave the gate green either
  // way. `CONTAINER_HOST` alone puts the client in remote mode, so nothing in
  // the suite or in `gate-stack.ts` had to learn a new spelling.
  //
  //   - the socket is read-only; the client needs no more than that, and the
  //     mount source is a path only this host can produce, hence the uid;
  //   - `/tmp` is an IDENTITY mount, rw, because bind sources are resolved by
  //     the podman that creates the container — the HOST's. The fixtures those
  //     tests build with `mkdtemp(tmpdir())` are otherwise paths the host
  //     cannot see, and podman fails the run rather than mounting an empty
  //     directory. Identity is what makes `os.tmpdir()` work untouched. A
  //     dedicated `.sandbar/gate-tmp` was rejected: its mount source must
  //     exist before bringup, and a bringup failure on an `attempt` container
  //     is a gate RED, so a `git clean -xfd` would blame the branch for a
  //     missing directory;
  //   - `SANDBAR_REQUIRE_PODMAN_TESTS=1` turns an unreachable podman into a
  //     FAILING test rather than a silent skip. Without it the day the socket
  //     breaks — a podman upgrade, a uid change, a `podman.socket` nobody
  //     re-enabled — is the day this gate quietly stops covering the layer it
  //     was given a socket for.
  gateStack: {
    containers: [
      {
        name: "runner",
        image: IMAGE,
        mountWorktree: "/workspace",
        hold: true,
        mounts: [
          { hostPath: PODMAN_SOCKET, containerPath: "/run/podman.sock" },
          { hostPath: "/tmp", containerPath: "/tmp", mode: "rw" },
        ],
        env: {
          CONTAINER_HOST: "unix:///run/podman.sock",
          SANDBAR_REQUIRE_PODMAN_TESTS: "1",
        },
      },
    ],
    // Split in three, and bounded explicitly rather than by the 15-minute
    // default. Steps stop at the first red, so the cheap suite still fails
    // fast — and the trace NAMES which layer broke, which matters because a
    // `podman-test` red has a second possible cause (the socket) that a `test`
    // red does not. Running unit tests beside podman tests was measured too:
    // their CPU work contends with mariadb bringup instead of filling idle
    // workers, costing 8s at K=1 and buying nothing at K=3.
    //
    // The `podman-test` step explicitly excludes
    // `gate-stack-hostpodman.test.ts`: it holds only for a LOCAL client, and
    // this one is remote. `sandbox-stack-podman.test.ts` (#44) is excluded too
    // for the same kind of reason — it builds its anchor with the
    // production sandbox run args and then execs into it as the agent, so "the
    // invoking user" has to be whoever runs the test rather than whoever owns
    // the socket. `container-resources-podman.test.ts` is local-client-only too:
    // the cgroup path returned by a remote client belongs to the remote host.
    // Those three stay host-only.
    //
    // `agent-sandbox-podman.test.ts` is remote-safe (#52): its assertions are
    // made through `podman exec`. There is no by-hand podman file list now;
    // vitest's project include glob plus the filename filter collects every
    // podman test except the three explicit local-client exceptions, so a new
    // podman file cannot silently disappear.
    //
    // NONE of that depends on this comment being right. All host-only files
    // declare `needsLocalClient`, so they self-skip against a remote client on
    // their own say-so. That remains the safety net when the glob collects a
    // newly added local-client file before this exclusion list knows its name.
    //
    // `npm test` on the host still runs everything. Those three are the whole
    // of the manual step: run them on the host after a
    // cycle that touched the podman layer, the sandbox run args or the sandbox
    // stack.
    steps: [
      { name: "check", in: "runner", command: ["npm", "run", "check"] },
      {
        name: "test",
        in: "runner",
        command: ["npm", "test", "--", "--exclude", "**/*-podman.test.ts"],
        timeoutMs: 900_000,
      },
      {
        name: "podman-test",
        in: "runner",
        command: [
          "npm",
          "test",
          "--",
          // A filename filter over the project's include glob owns the podman
          // file list; only the three local-client suites stay outside it.
          "podman.test.ts",
          "--exclude",
          "src/gate-stack-hostpodman.test.ts",
          "--exclude",
          "src/sandbox-stack-podman.test.ts",
          "--exclude",
          "src/container-resources-podman.test.ts",
          // Measured on the 12-core x3 host: 2 workers cost 254s per gate, 4
          // cost 222s, 8 cost 207s, and Vitest's 11-worker default cost 213s.
          // Eight is the flat optimum at K=1 and K=3 and leaves host capacity;
          // maxConcurrency=3 keeps the other side of the product explicit.
          "--maxWorkers",
          "8",
        ],
        // `gate-run-podman.test.ts` (#45) is collected here rather than staying
        // host-only: it drives `runGateCommand` end to end, and every podman
        // call it makes goes through the same client as the others. It declares
        // no `needsLocalClient` because it needs none — nothing in it asks a
        // question about the host's own session.
        //
        // The retained 51 tests report 0 skipped. On the measured quiet K=1
        // host this step takes 71s at eight workers and all three test steps
        // take 79s; at K=3 the whole workload takes 208s per gate. The 30-minute
        // hard bound remains sized for loaded shared hosts and deliberate
        // readiness/step timeouts, not as a performance assertion.
        timeoutMs: 1_800_000,
      },
    ],
  },

  // Restating the default `{ tag, containerfile }` only to add `rebuildOn`,
  // which is the one thing that default cannot express. An entry with an EMPTY
  // `rebuildOn` does not participate in fingerprinting at all
  // (`fingerprintImageInputs` returns null for it), so `ensureImages` skips the
  // build whenever the TAG exists — edit the Containerfile and the stale image
  // is silently reused, and a branch that adds a tool to the image is gated
  // against the version without it. Listing the recipe is what opts the entry
  // in; its bytes are then hashed (twice, harmlessly) and #37 does the rest —
  // rebuilt at startup when it moves, and given a per-branch variant, built
  // from that worktree, when a branch is what moved it.
  //
  // Nothing else belongs here: the image bakes no dependency of this repo (see
  // the `npm ci` hook above), and every path listed is hashed on every gate run.
  //
  // `rebuildOn` paths must EXIST in `worktrees/source`, i.e. on
  // origin/<sourceBranch> — so this line and a committed, pushed Containerfile
  // are one unit. Adding it before the file lands upstream refuses the run.
  images: [
    { tag: IMAGE, containerfile: "Containerfile", rebuildOn: ["Containerfile"] },
  ],

  // The credential the codex routing below spends is the ChatGPT subscription,
  // not the API (#73). The included pool is the whole discount — top-up credits
  // are priced at API parity — and `OPENAI_API_KEY` bills the API without
  // touching it. The subscription is a FILE: run
  // `CODEX_HOME=~/.codex-sandbar codex login` once on this host, and
  // `CODEX_AUTH_JSON` carries that dedicated file as a value,
  // which this file is a program and reads for itself. Not `sandbar.env`: that
  // parser is line-based and `auth.json` is pretty JSON. Declare ONE of the
  // two — codex prefers `OPENAI_API_KEY` when both are visible, so a config
  // carrying both pays the subscription and bills the API anyway, which
  // preflight warns about. There is deliberately no fallback to the operator's
  // `~/.codex/auth.json`: its TUI and Sandbar must use different token families
  // so either side can refresh without invalidating the other (#134).
  env: {
    ...credentials,
    CODEX_AUTH_JSON: readFileSync(join(homedir(), ".codex-sandbar/auth.json"), "utf8"),
  },

  // Which CLI, model and effort each role runs on is NOT decided here. Since
  // #137 the routing is per installation and lives in `sandbar.env` as the
  // fifteen `SANDBAR_*` keys `splitRoleRouting` consumed above; this spread is
  // the whole of it, and an absent or empty key keeps the driver's default
  // (claude, "opus", no `--effort`). The driver still enforces the pairing
  // after the spread (`assertRoleModelIdNamed`): a role moved to codex without
  // a model id would ask codex for "opus" on every attempt, so move an agent
  // and its model id together.
  //
  // The reasoning behind the routing this host actually runs — the
  // implementer, the quality reviewer pass and the merger on codex against the
  // ChatGPT subscription (#72, #73, #121, #130), correctness on claude/opus
  // because the deciding verdict belongs on the strongest model, and every
  // codex role naming `high` because the sandbox reads no host `config.toml`
  // and the server default for gpt-5.6-sol is `low` — is written beside the
  // keys in `sandbar.env.example`. Backing a role out is an edit to the env
  // file and needs no landing; the level a call ran at is on its
  // implementer/review-pass event as `effort`.
  //
  // Nothing here takes effect through the pin. This file comes from the
  // checkout, not from `.sandbar/driver/`, so an edit applies on the next run
  // — but the DRIVER that reads it must already understand the field, which is
  // what `requiresSandbar` is checking.
  ...routing,

  // No `mergeMode`: the default `{ kind: "direct" }` is what this repo wants,
  // and restating a default is noise (see RunConfig's deviations-only rule).
  // Nothing downstream of `main` here trusts it blindly — `auto-tag.yml` reads
  // package.json and creates a tag, which is bookkeeping, not a deploy — so the
  // one thing `verified` protects against does not apply.
};
