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
  // Known blind spot, and the reason for `verified` below: the podman-backed
  // tests (`gate-stack-podman.test.ts`, `ensure-images-podman.test.ts`) resolve
  // their `describe.runIf` at collection time against `podman image exists`,
  // and there is no podman inside this container. They SKIP — green either way
  // — and they are exactly the tests that pin what podman defines. Do not
  // close that gap by mounting the podman socket in here: both files hardcode
  // a fixed scope and stack id, so two issues gating concurrently (default plan
  // size 3) would build identically-named pods and force-remove each other's.
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

  // The forge gets the last word, and that is this repo's whole answer to the
  // blind spot above — verified mode's stated purpose verbatim: buying an
  // independent verdict the local gate cannot. `.github/workflows/test.yml`
  // runs the SAME suite on a runner that has podman, so the 35 tests skipped
  // locally actually run before anything lands on main.
  //
  // `requiredChecks` is the job name AS THE FORGE REPORTS IT. The workflow and
  // this line are one unit: a name that never appears is `missing-required`,
  // which is fatal every cycle by design. Adding a matrix to that job renames
  // the checks (`test (20.x)`) and must change this line in the same commit.
  mergeMode: {
    kind: "verified",
    requiredChecks: ["test"],
  },
};
