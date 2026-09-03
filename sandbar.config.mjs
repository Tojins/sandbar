// Sandbar operating on sandbar (#39).
//
// Since #66 this repo is worked on by a PINNED sandbar, exactly as a consumer's
// would be: `sandbar.pin` names a tag, `npm run sandbar` installs it into
// `.sandbar/driver/` and runs that, and nothing in a series is built from the
// working tree. The old launcher was `git pull --ff-only && npm run build &&
// node dist/cli.js` in a loop, which meant the orchestrator AND the gate stack
// were whatever a human had saved; the loop now re-reads the pin and loops on
// EXIT_CODE_RELAUNCH (75) alone, which `relaunchAfterLanding` below is what
// produces. Why the relaunch survives the pin — the Containerfile is still
// resolved once per run — is RunConfig's to state.
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
// lands on main judges nothing until a human pulls it here, however many
// relaunches the series makes in between. That is the deliberate trade — a
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
  ".sandbar/driver/node_modules/@offergeist/sandbar/dist/index.js",
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
const { readEnvFile } = await import(DRIVER_ENTRY.href);

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
  // It is 0.24.6, the first TAGGED release that augments the resolved sandbox
  // image with the routed agent CLIs (#75) — and this file started asking for
  // that the moment the Containerfile stopped baking a CLI of its own: under a
  // non-augmenting driver the image this config names would put an agent in a
  // sandbox with NO CLI at all, a 127 on every attempt rather than a refusal.
  // (#75 landed a few versions earlier in the same pass, but an untagged
  // version is not installable, so a lower floor would buy nothing.) The
  // previous floor, 0.23.0, was the codex routing below (#72) and its
  // subscription credential (#73); 0.24.6 subsumes it. It moves when this file
  // starts asking a newer sandbar for something, not when the pin does.
  requiresSandbar: "0.24.6",

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
      onWorktreeReady: [{ command: "npm ci", timeoutMs: 600_000 }],
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
    // the socket. Those two stay host-only.
    //
    // `agent-sandbox-podman.test.ts` is remote-safe (#52): its assertions are
    // made through `podman exec`. There is no by-hand podman file list now;
    // vitest's project include glob plus the filename filter collects every
    // podman test except the two explicit local-client exceptions, so a new
    // podman file cannot silently disappear.
    //
    // NONE of that depends on this comment being right. Both host-only files
    // declare `needsLocalClient`, so they self-skip against a remote client on
    // their own say-so. That remains the safety net when the glob collects a
    // newly added local-client file before this exclusion list knows its name.
    //
    // `npm test` on the host still runs everything. The two host-only files
    // above are the whole of the manual step: run them on the host after a
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
          // file list; only the two local-client suites stay outside it.
          "podman.test.ts",
          "--exclude",
          "src/gate-stack-hostpodman.test.ts",
          "--exclude",
          "src/sandbox-stack-podman.test.ts",
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
  // touching it. The subscription is a FILE: `codex login` on this host writes
  // `~/.codex/auth.json`, and `CODEX_AUTH_JSON` carries its content as a value,
  // which this file is a program and reads for itself. Not `sandbar.env`: that
  // parser is line-based and `auth.json` is pretty JSON. Declare ONE of the
  // two — codex prefers `OPENAI_API_KEY` when both are visible, so a config
  // carrying both pays the subscription and bills the API anyway, which
  // preflight warns about. Re-run `codex login` here if a series is ever
  // refused for a stale token: the container's copy refreshes in place and
  // this host's can be left behind.
  env: {
    ...readEnvFile(new URL("sandbar.env", import.meta.url)),
    CODEX_AUTH_JSON: readFileSync(join(homedir(), ".codex/auth.json"), "utf8"),
  },

  // The implementer runs codex (#72), on the subscription above (#73); the
  // pair is deviations from "claude"/"opus", so only the routed role is
  // spelled. The model id is the same field the claude default used, holding
  // the other vendor's id — the driver enforces the pairing rather than
  // trusting it (`assertRoleModelIdNamed`): a model id left unset is the
  // claude alias "opus", so a half-moved config would ask codex for it on
  // every attempt. Preflight refuses the run when no codex credential is
  // declared in `env`, rather than letting the failure arrive as an
  // implementer dying in-container.
  //
  // The reviewer stays claude on purpose: it holds the verdict, and #72's
  // whole argument is that the strongest model belongs where the judgement is,
  // not where the tokens are. The merger has the same independent
  // provider/model knobs since #74 and stays on its claude/opus defaults for
  // the reviewer's reason — conflict resolution is judgement — not for
  // compatibility; the codex merger route is driver-supported but unexercised
  // by this self-host configuration.
  //
  // Nothing here takes effect through the pin. This file comes from the
  // checkout, not from `.sandbar/driver/`, so an edit applies on the next run
  // — but the DRIVER that reads it must already understand the field, which is
  // what `requiresSandbar` is checking.
  implementerAgent: "codex",
  implementerModelId: "gpt-5.6-sol",

  // Exit 75 after any cycle that lands merges, so `scripts/sandbar-launch.mjs`
  // re-reads the pin and relaunches (#65). Explicit rather than detected — see
  // RunConfig — and still set here after #66, for the Containerfile: images are
  // resolved once per run from a worktree at origin/main, so a landed image
  // change reaches a series through the relaunch and through nothing else.
  //
  // What it does NOT buy is a fresh copy of THIS FILE. The relaunch re-imports
  // it, but out of this checkout, and nothing pulls into a checkout any more —
  // that was the launcher's `git pull`, deleted by #66 so a series can run while
  // the operator holds local commits. So a gate-stack change that lands on main
  // starts judging branches when a human pulls it here, not one relaunch later;
  // preflight says so when the commits this checkout is missing touch this file.
  // Budgets and stuck counters are per-run and reset across runs by design, so
  // the relaunch resets them exactly as a human re-launch would.
  relaunchAfterLanding: true,

  // No `mergeMode`: the default `{ kind: "direct" }` is what this repo wants,
  // and restating a default is noise (see RunConfig's deviations-only rule).
  // Nothing downstream of `main` here trusts it blindly — `auto-tag.yml` reads
  // package.json and creates a tag, which is bookkeeping, not a deploy — so the
  // one thing `verified` protects against does not apply.
};
