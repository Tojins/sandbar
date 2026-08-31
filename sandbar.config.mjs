// Sandbar operating on sandbar (#39).
//
// This repo IS the package, so there is nothing to `npm i` and no `npx sandbar`
// on PATH: the import below is the local build, and the launcher is
// `npm run sandbar` — a LOOP since #65: pull --ff-only, build, run, and go
// again only when the run exits EXIT_CODE_RELAUNCH (75, hardcoded in the
// script because a shell loop cannot import a constant). That code is what
// `relaunchAfterLanding` below makes any landing cycle exit with, so an
// unattended series is always driven by what it just landed — the launch tree
// supplies `dist/`, THIS FILE and the Containerfile, while judged trees come
// from origin/<sourceBranch>, and before #65 a queued chain of outer-loop
// issues had slice N+1 built by a driver predating slice N (found 40 commits
// behind once, across a `feat!`). The pull at the top of the loop closes the
// at-launch half of the same gap; a dirty or diverged checkout makes it fail
// loud with git's own message, no stash, no guessing.
//
// The residual is the one #39 already accepted: a subtle regression in slice N
// now mis-drives slice N+1 UNATTENDED, one relaunch later rather than one
// manual launch later. Recovery is a hand `git revert` — while preflight
// refuses to start on the leftover branches.
import { readEnvFile } from "./dist/index.js";

// One image serves both roles — the agent sandbox (`--user 1000:1000
// --userns=keep-id`) and the gate runner (a pod member, where keep-id is
// impossible and container root is what maps back to the invoking user). See
// the Containerfile, which is why it defines an `agent` user at uid/gid 1000
// and leaves its default USER as root.
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
    // default, which was sized for a suite that skipped 35 tests. Steps stop at
    // the first red, so the cheap suite still fails fast — and the trace then
    // NAMES which layer broke, which matters because a `podman-test` red has a
    // second possible cause (the socket) that a `test` red does not.
    //
    // The exclude glob deliberately misses `gate-stack-hostpodman.test.ts`,
    // which self-skips: it holds only for a LOCAL client, and this one is
    // remote. `sandbox-stack-podman.test.ts` (#44) is excluded and not named
    // below for the same kind of reason — it builds its anchor with the
    // production sandbox run args and then execs into it as the agent, so "the
    // invoking user" has to be whoever runs the test rather than whoever owns
    // the socket. Those two stay host-only.
    //
    // `agent-sandbox-podman.test.ts` USED to be a third, on an unknown rather
    // than a measured difference; #52 measured it — its `--init` assertions are
    // made inside the container through `podman exec`, so a remote client
    // observes them identically — and it is named below. The glob still
    // excludes it from `test`, which is why naming it here is the whole of the
    // wiring.
    //
    // NONE of that depends on this comment being right. Both host-only files
    // declare `needsLocalClient`, so they skip against a remote client on their
    // own say-so — which matters because a glob and a by-hand file list are two
    // lists that drift, and the drift is silent in the direction that hurts
    // (a host-only file quietly added to `podman-test` would be a red nobody
    // asked for; one quietly dropped from BOTH would be a layer nobody runs).
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
          // The five gate-stack shards are ONE suite split for wall-clock
          // parallelism — vitest runs a file's tests sequentially, and unsplit
          // they bounded the whole run. The slice map is
          // `gate-stack-podman.test-util.ts`'s header.
          "src/gate-stack-podman.test.ts",
          "src/gate-stack-health-podman.test.ts",
          "src/gate-stack-timeout-podman.test.ts",
          "src/gate-stack-images-podman.test.ts",
          "src/gate-stack-standalone-podman.test.ts",
          "src/ensure-images-podman.test.ts",
          "src/agent-sandbox-podman.test.ts",
          "src/gate-run-podman.test.ts",
        ],
        // `gate-run-podman.test.ts` (#45) is named here rather than staying
        // host-only: it drives `runGateCommand` end to end, and every podman
        // call it makes goes through the same client as the others. It declares
        // no `needsLocalClient` because it needs none — nothing in it asks a
        // question about the host's own session.
        //
        // 30 minutes. The only wall-clock measurement anyone has taken here is
        // #48's 229s, and it is quoted as the historical figure it is: it timed
        // two of these files when they held 33 tests between them, and #45,
        // #49, #50 and #52 have since taken this step to 59, measured with
        // `vitest list` on this tree — several of the additions being
        // readiness timeouts the tests ask for deliberately, and #45's own
        // being bringups it cannot avoid (reuse and keep-alive are only
        // assertable by bringing a stack up more than once, and most of its
        // `runGateCommand` invocations bring one up). The bound stays where it
        // is because it was never sized against that figure: the runtime is
        // dominated by mariadb bringup and by those deliberate timeouts, and
        // three gates run concurrently at the default plan size, contending
        // for one podman. Do not tighten it towards a number that has not
        // been re-measured.
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

  env: readEnvFile(new URL("sandbar.env", import.meta.url)),

  // Exit 75 after any cycle that lands merges, so the launcher loop above can
  // pull, rebuild and relaunch (#65). Explicit rather than detected — see
  // RunConfig — and set HERE because this is the one repo where the landed
  // commits are the orchestrator itself. Budgets and stuck counters are
  // per-run and reset across runs by design, so the relaunch resets them
  // exactly as a human re-launch would.
  relaunchAfterLanding: true,

  // No `mergeMode`: the default `{ kind: "direct" }` is what this repo wants,
  // and restating a default is noise (see RunConfig's deviations-only rule).
  // Nothing downstream of `main` here trusts it blindly — `auto-tag.yml` reads
  // package.json and creates a tag, which is bookkeeping, not a deploy — so the
  // one thing `verified` protects against does not apply.
};
