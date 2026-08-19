// Sandbar operating on sandbar (#39).
//
// This repo IS the package, so there is nothing to `npm i` and no `npx sandbar`
// on PATH: the import below is the local build, and the launcher is
// `npm run sandbar` (build, then `node dist/cli.js`). That coupling is the one
// thing about self-hosting that differs from any other host repo, and it has a
// consequence worth remembering before queueing work: the orchestrator driving
// a cycle is whatever `dist/` held when the run STARTED, so a merged regression
// in the outer loop breaks the NEXT run, not the one that merged it. Recovery
// is a hand `git revert` — while preflight refuses to start on the leftover
// branches. Keep issues that touch run.ts / inner-loop / merger off
// `ready-for-agent` until a few cycles have landed cleanly.
import { readEnvFile } from "./dist/index.js";

// One image serves both roles — the agent sandbox (`--user 1000:1000
// --userns=keep-id`) and the gate runner (a pod member, where keep-id is
// impossible and container root is what maps back to the invoking user). See
// the Containerfile, which is why it defines an `agent` user at uid/gid 1000
// and leaves its default USER as root.
const IMAGE = "localhost/sandbar-agent:latest";

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

  // What it takes to produce a verdict about a commit here: one container, two
  // steps. `hold: true` because the image has no long-running process of its
  // own; default `lifecycle: "attempt"` because it mounts the worktree and runs
  // the branch's code, so it is recreated every gate run.
  //
  // KNOWN BLIND SPOT, accepted deliberately. The podman-backed tests
  // (`gate-stack-podman.test.ts`, `ensure-images-podman.test.ts`) resolve their
  // `describe.runIf` at collection time against `podman image exists`, and
  // there is no podman inside this container. ~35 tests SKIP — green either
  // way — and they are exactly the ones pinning what podman defines: the tcp
  // settle window's green-on-red, root-in-pod file ownership, `inspect` 125 vs
  // `container exists` (#36), SIGKILL reaping, `logs -f` chunk splitting.
  //
  // They run on the HOST instead, where `npm test` is 877/877 with podman
  // present. That is a human step, not a gate: a green gate here does NOT mean
  // that layer was exercised. Run the full suite on the host before trusting a
  // cycle that touched `gate-stack.ts`, `ensure-images.ts` or `containers.ts`.
  //
  // Neither of the two mechanical ways to close it is available. Mounting the
  // podman socket into this container does not work: both files hardcode a
  // fixed `SCOPE` and `STACK_ID`, so two issues gating concurrently (default
  // plan size 3) build identically-named pods and `startStack` force-removes a
  // namesake before creating — each issue's gate would destroy the other's
  // stack mid-run. That route needs a prerequisite issue deriving the test
  // scope per-process. `mergeMode: "verified"` was the other, and is out by
  // choice: this is a personal project, the tests belong on host machines, and
  // a cycle should not wait on a hosted runner.
  gateStack: {
    containers: [
      {
        name: "runner",
        image: IMAGE,
        mountWorktree: "/workspace",
        hold: true,
      },
    ],
    steps: [
      { name: "check", in: "runner", command: ["npm", "run", "check"] },
      { name: "test", in: "runner", command: ["npm", "test"] },
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

  // No `mergeMode`: the default `{ kind: "direct" }` is what this repo wants,
  // and restating a default is noise (see RunConfig's deviations-only rule).
  // Nothing downstream of `main` here trusts it blindly — `auto-tag.yml` reads
  // package.json and creates a tag, which is bookkeeping, not a deploy — so the
  // one thing `verified` protects against does not apply.
};
