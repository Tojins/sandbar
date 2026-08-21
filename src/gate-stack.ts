// The gate stack (#24): several containers on one network namespace, and an
// ordered list of steps that run in them, producing one verdict about one
// commit.
//
// This replaces the single DB sidecar of #20. The shape a real repo needs is
// not "a database plus two npm scripts" — it is a database, a mail catcher, an
// application server, a frontend dev server and five steps spread across them,
// some of which only exist because the branch under test builds them.
//
// ---------------------------------------------------------------------------
// The pod
// ---------------------------------------------------------------------------
// Every container joins one podman POD, so the whole stack shares a network
// namespace and addresses itself as `127.0.0.1`. Nothing is published for the
// stack's own use, so a gate run cannot collide with the operator's dev stack
// or with another issue's gate running in parallel.
//
// A pod, not the `--network container:<anchor>` chain a docker-based launcher
// has to use. The anchor mechanism exists only because docker has no pods, and
// it costs two real constraints: the anchor owns the namespace (so the `--dns`
// flags must go on it, and every joiner inherits whatever it was created with),
// and REMOVING the anchor destroys the namespace — so the anchor can never be a
// container that is recreated per attempt. `RUNTIME` is podman, so sandbar owes
// none of that: the pod is created first, holds the resolver config, and
// survives every container's removal. There is no `anchor` in sandbar's config.
//
// SANDBAR NOW RUNS BOTH TOPOLOGIES, and the paragraph above is why the second
// one is not a contradiction (#44). The sandbox stack — the same containers,
// beside the AGENT rather than beside the steps — uses the anchor chain, and
// every objection just made is an objection to the anchor being a FOREIGN
// container. There the anchor is the agent's own sandbox: created first,
// outliving every sibling, never recreated per attempt, and the natural owner
// of any namespace-wide flag — of which, since #43 moved every readiness probe
// inside the container, there are none left to want. What forces the choice is
// that a pod cannot host it at all — `--pod` and `--userns=keep-id` are
// refused together, and the agent needs keep-id (uid 1000, `HOME=/home/agent`,
// and a `--dangerously-skip-permissions` that refuses to run as root). So:
// pods where a pod is possible, the chain where it is not. See
// sandbox-stack.ts, and `ContainerAttachment` below for the one place the two
// meet in this module.
//
// What the pod costs: `--userns=keep-id` and `--pod` cannot be combined
// (podman refuses outright), and `--user 1000:1000` inside a pod maps to a
// SUBUID, not to the invoking user — a container that writes to the mounted
// worktree that way gets EACCES. Container ROOT under rootless podman maps to
// the invoking user, so a worktree-mounting container must run as root or as
// the host uid, which is checked empirically before the run starts
// (ensure-images.ts) rather than discovered as a mysterious mid-gate failure.
//
// The per-issue network stays underneath the pod. The pod isolates the
// namespace, but two pods on one shared bridge could still reach each other,
// and `--disable-dns` (#18) is a property of the network: on WSL2 the
// aardvark-dns resolver dies with the systemd user bus across suspend/resume
// and leaves every in-bridge lookup a black hole. The pod carries explicit
// public `--dns` servers so external resolution still works, and every
// container in it inherits them.
//
// ---------------------------------------------------------------------------
// Whose failure is a failed bringup
// ---------------------------------------------------------------------------
// `lifecycle` decides, and it is the most consequential field in the config.
// An `issue` container (a database, a mail catcher) depends only on its image
// and its env — never on the branch — so its failure is infra: it throws, the
// runner wraps it as HARD-ERROR, and the issue retries with a fresh stack. An
// `attempt` container mounts the worktree and runs the branch's code, so its
// failure is the branch's fault like any red test: gate red, with the
// container's log as the trace, and the implementer gets another attempt.
//
// Getting that backwards is not a style question. An agent that breaks the
// service bootstrap produces a readiness timeout; under a blanket
// "container failure = infra" rule that becomes two fresh-stack retries
// reproducing the identical failure and then NEEDS-HUMAN with an
// "environment" trace — for a bug the implementer could have fixed on the next
// attempt if it had been shown the log.
//
// The mapping has to hold for the whole life of the stack, not just its first
// second, and two liveness checks are what make it. A container with no
// `readiness` declared is still asserted alive after a grace interval —
// `podman run -d` exits 0 for an entrypoint that dies immediately, so without
// that check a dead mail catcher passes bringup and is then blamed on the
// branch by every step that talks to it. And the `issue` containers are
// re-checked before EVERY gate run: a database OOM-killed at attempt 4 is still
// infrastructure, so it throws rather than reddening, and the fresh-stack retry
// does what it exists to do instead of burning the rest of the budget against a
// corpse.
//
// ---------------------------------------------------------------------------
// Nothing here may hang
// ---------------------------------------------------------------------------
// This module holds the run's single-instance lock while it works, and node's
// execFile has NO default timeout, so an unbounded exec is not a slow gate —
// it is a run that never ends and never tears down. EVERY podman call in this
// module goes through `boundedPodman`, which does its OWN timing rather than
// passing node's `timeout:` option — see that function, and note that the
// option it replaces did not merely fail to bound a `podman exec`, it reported
// the hung call as a SUCCESS. Steps are bounded by `step.timeoutMs` (#26, per
// step because a lint step and a browser suite do not want the same ceiling);
// readiness probes and postReadyCommands by the container's own readiness
// budget; the calls sandbar makes ABOUT a container rather than through it
// (`logs`, `inspect`, `container exists`) by LOG_READ_TIMEOUT_MS; and
// everything that creates or destroys a pod, network or container by
// CONTROL_TIMEOUT_MS. Podman's own `--health-timeout` is NOT one of these and
// is not passed: it does not kill, it retro-labels (see Readiness below). The
// one thing a gate run still shells out to unbounded is not podman:
// `dirtyWorktreePaths`' `git status` (git-ops.ts).
// Note that `readinessTimeoutMs` alone does not do this: the poll loop only
// tests its deadline BETWEEN probes, so one probe that never returns hangs
// forever inside a perfectly valid budget.
//
// A step that exceeds its bound is a gate RED, not a HARD-ERROR — the same
// argument as D5. A suite that hangs is nearly always the branch's own code (a
// test awaiting a promise that never resolves, a reporter that never exits),
// not the environment, so the implementer gets another attempt with a trace
// naming the step and the bound; a hang that IS environmental recurs, exhausts
// the attempt budget and lands on NEEDS-HUMAN carrying that same trace.
//
// There is deliberately no bound on the gate as a WHOLE. A gate run stops at
// the first red, so one hung step costs exactly one step's bound; a second
// number would only add a way to kill a legitimately slow run without being
// able to say which step it killed. The residual is that a stack of N slow but
// PASSING steps can run for the sum of their bounds — finite, and computable by
// the operator from the config in front of them.
//
// Killing the step is not the end of it: killing the `podman exec` CLIENT does
// not touch the process inside the container (also pinned against real podman),
// so a timed-out step leaves its work running, burning CPU beside the next
// attempt and skewing whatever the next gate run measures. The only handle
// podman offers that is total, and that needs no tools in an image sandbar does
// not control, is the container itself: `reapKilledStep` removes it. For an
// `attempt` container that is free — the next gate run recreates it anyway —
// and an `issue` one is recreated on the spot. That recreate used to be the
// only thing between this reap and a verdict misblamed on the branch, because
// `assertIssueContainersAlive` could not see a REMOVED container at all; since
// #36 it can, so the recreate is now an optimisation — read that function for
// what it saves and what it costs. The same reap runs on a maxBuffer kill,
// which strands a process for exactly the same reason.
//
// A recreate that fails is the one case where a killed step does not produce a
// gate red: the bringup error wins and the run takes a HARD-ERROR instead.
//
// Every podman call this module makes is now a bounded `execFile`. The one
// long-lived `spawn` it used to hold — the `podman logs -f` follower behind
// `log` readiness — went with that kind in #43, and with it the whole
// signal-coverage caveat that followed: there is no longer any child here that
// can outlive its parent on SIGKILL or an untrapped SIGHUP. sandbox-stack.ts
// spawns one deliberately — a `podman logs -f` per sibling, producing an
// artefact rather than deciding readiness — and states that caveat itself.
//
// ---------------------------------------------------------------------------
// Readiness: podman owns the probe, sandbar owns the schedule (#43)
// ---------------------------------------------------------------------------
// One kind. The container is created with `--health-cmd '<json argv>'` and
// `--health-interval=disable`, and every poll calls `podman healthcheck run`.
// The probe therefore runs INSIDE the container, which is what retires the
// three hand-rolled kinds this replaced — `tcp` (a host-side connect through a
// published port), `log` (a followed `podman logs -f` scanned for a substring)
// and `exec` (a bare `podman exec`) — along with roughly 250 lines that existed
// only to make the first two work.
//
// SANDBAR POLLS; PODMAN DOES NOT SCHEDULE, and that inverts the obvious
// implementation on purpose. `--health-interval=Ns` plus one
// `podman wait --condition=healthy --condition=unhealthy` looks like less code
// and is worse on three counts, each measured against podman 4.9.3:
//
//   - podman schedules healthchecks with TRANSIENT SYSTEMD TIMERS, so a real
//     interval needs a systemd user session (a rootless podman inside a CI
//     container may have none) and creates a unit named by CONTAINER ID —
//     outside the `sandbar-<scope>-*` namespace `cleanupOrphanContainers`
//     sweeps, so a SIGKILLed run leaks a timer nothing reaps that keeps firing
//     against a container that is gone. #28's scope has no reach into the
//     systemd unit namespace. With `--health-cmd` AND `disable`, podman creates
//     no unit at all: the dependency is designed out rather than probed for.
//   - `podman wait` buys no verdict. It accepts both conditions and then prints
//     `-1` and EXITS 0 for either outcome, so the `inspect` happens anyway.
//   - `--health-timeout` DOES NOT KILL. A 2s timeout against a 30s probe
//     returns after 30.3s and then labels the result `exceeded timeout of 2s`,
//     recorded as `ExitCode: -1`. Under `wait` that means blocking on a probe
//     podman has declined to kill — "nothing here may hang" reintroduced
//     through its own fix. So the flag is deliberately NOT passed and not
//     exposed in config: a number that looks like a per-probe bound but only
//     retro-labels is #26's green-on-red wearing podman's colours.
//     `readinessTimeoutMs` remains the single real bound, enforced here.
//
// What the poll keeps unchanged: `readinessTimeoutMs`, the `remainingMs`
// arithmetic, `throwIfDead` between probes, `READY_POLL_INTERVAL_MS`.
//
// TWO THINGS ABOUT THE HEALTH LOG MISLEAD SILENTLY, so read them before
// debugging a probe:
//
//   - EXIT CODES ARE NORMALISED. A probe that exits 3 is recorded as
//     `ExitCode: 1`; a podman-timeout is recorded as `-1`. The number in the
//     log is not the number the probe returned.
//   - `lastErr` MUST COME FROM THE HEALTH LOG, NOT FROM THE CLIENT — WITH ONE
//     EXCEPTION THAT IS NOT OPTIONAL. `podman healthcheck run`'s own stdout on
//     failure is the single word `unhealthy`, so a "last probe: unhealthy"
//     built from the client's output says less than the probe it replaced. The
//     last entry's `Output` is the useful text, so the timeout reads it — once,
//     at the deadline, where it also collects the most recent entries for the
//     trace, sliced to HEALTH_LOG_ENTRIES.
//     The exception is a probe SANDBAR KILLED at the deadline: it records no
//     entry at all, because the client died before podman could write one. The
//     newest entry is then some earlier, faster failure, and rendering it
//     reports "exit 1: connect failed" for a probe that in fact stopped
//     returning — nothing else in the message, health block or log tail
//     included, would mention the kill. So `probeOnce` carries `timedOut` out
//     beside the detail and `lastProbeText` leads with it. Since our deadline is
//     the only bound there is (`--health-timeout` does not kill, above), that
//     kill is the single most useful thing the error can say.
//
// The health block is ADDED TO `ContainerBringupError`, not swapped for the
// container log tail. The health log says what the probe saw; D9's argument
// runs the other way too — WHY a probe failed is usually in the container's own
// log — so the error carries both, health above tail.
//
// Residual, stated: killing the `podman healthcheck run` client leaves the
// probe process running inside the container. That is what the `exec` kind
// already did and what this module's header already documents for steps — no
// regression and no new reap.
//
// Known limitation: a `scratch` image with no shell and no probe binary can no
// longer declare readiness, where `tcp` could, since there is nothing in it to
// run. No stack has such a container; the escape hatches are a static probe
// binary in the image, or `hold: true` plus a `postReadyCommand`.

import { execFile } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { onCleanup } from "./cleanup.js";
import type {
  ResolvedGateStack,
  ResolvedStackContainer,
  ResolvedStackMount,
} from "./config.js";
import { type ImageMap, ImageBuildError } from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { type GateResult, stripAnsi } from "./gate.js";
import { dirtyWorktreePaths } from "./git-ops.js";
import {
  type RunScope,
  networkNameFor,
  podNameFor,
  stackContainerNameFor,
} from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Bounded podman calls (#26)
// ---------------------------------------------------------------------------
// Every podman call that could take arbitrarily long goes through
// `boundedPodman`, and it does the timing ITSELF rather than passing node's
// `timeout:` option — because on a `podman exec` that option is a green-on-red.
//
// Node's timeout kills the child with SIGTERM, and `podman exec` EXITS 0 on
// SIGTERM. Node's exit handler reports an error only for a non-zero code or a
// non-null signal, so the call RESOLVES, with whatever partial output had been
// flushed and no indication anything went wrong. A hung test suite would be a
// GREEN gate; a hung `exec` readiness probe would mark its container ready; a
// hung postReadyCommand would report a seeded database. All three were live —
// the readiness probe and the postReadyCommands have carried `timeout:` since
// #24 and neither has ever been able to fail. Pinned in
// gate-stack-podman.test.ts, because it is a fact about podman, not about node.
//
// So the deadline is ours, the signal is SIGKILL (which podman cannot exit 0
// from, and which cannot be ignored — a client that swallowed SIGTERM would
// reintroduce the very hang this closes), and `timedOut` is a flag set by the
// timer, never inferred from the exit code.
//
// It also never throws for a process-level failure. Every caller here has to
// tell "it failed" from "it never answered" — a readiness probe that exits 1 is
// not ready, one that hangs is not ready AND has left a process behind — and an
// exception collapses those into one channel.
export type BoundedResult = {
  readonly stdout: string;
  readonly stderr: string;
  // null when the process was killed rather than exiting on its own.
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly maxBufferExceeded: boolean;
  // Node's own message ("Command failed: …"), for prose. "" on success.
  readonly errorMessage: string;
};

// Exported since #44: sandbox-stack.ts drives podman for the sandbox siblings
// and every claim this module makes about not hanging (and about `podman exec`
// exiting 0 on SIGTERM) applies there verbatim.
//
// `onChunk` is a TEE, not a replacement for the buffering (#45). The standalone
// `sandbar gate` has a human or a CI log in front of it, and a step that prints
// nothing for fifteen minutes and then dumps everything at once is a worse
// runner than the bash script it replaces. Every consumer of `BoundedResult`
// still gets the complete captured output — the gate trace, the D9 log block
// and `summarizeGateFailure` all read the buffer, so nothing downstream has to
// know whether anyone was watching. `execFile` collects through its own
// listeners on the same streams, and a second `data` listener sees the same
// chunks, so this costs one extra listener and no behaviour.
export function boundedPodman(
  args: readonly string[],
  timeoutMs: number,
  onChunk?: (chunk: string) => void,
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let killedByTimer = false;
    // Hoisted, not declared after `execFile`. `clearTimeout(timer)` below is
    // safe only because execFile never invokes its callback synchronously, and
    // a TDZ ReferenceError raised inside that callback would surface as an
    // uncaught throw rather than a rejected promise.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      RUNTIME,
      [...args],
      { maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        const e = err as
          | (Error & { code?: number | string; signal?: string })
          | null;
        resolve({
          stdout,
          stderr,
          exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : null,
          // `e !== null` keeps a call that exited 0 in the same tick the timer
          // fired from being read as a timeout — a false red costing an
          // implementation attempt. It does NOT cover the mirror case: a call
          // that exits NON-ZERO inside that same window is reported as a
          // timeout. Against a 15-minute default the window is microseconds,
          // and both readings are red, so the asymmetry is priced in rather
          // than closed.
          timedOut: killedByTimer && e !== null,
          maxBufferExceeded: e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          errorMessage: e?.message ?? "",
        });
      },
    );
    if (onChunk !== undefined) {
      // ANSI-stripped here rather than at the sink, so the live view and the
      // trace read alike — a stream showing raw `^[[90m` where the trace shows
      // clean text is two accounts of one step. Per CHUNK, so an escape or a
      // multi-byte character straddling a chunk boundary survives into the live
      // view; that is a cosmetic artefact of the tee alone and never reaches
      // the buffer, which node decodes whole.
      const tee = (buf: Buffer | string): void => {
        onChunk(stripAnsi(buf.toString()));
      };
      child.stdout?.on("data", tee);
      child.stderr?.on("data", tee);
    }
    timer = setTimeout(() => {
      killedByTimer = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  });
}

// Did the call exit 0 on its own?
export function boundedOk(r: BoundedResult): boolean {
  return r.exitCode === 0 && !r.timedOut && !r.maxBufferExceeded;
}

// A control-plane call whose failure means the stack cannot exist. Throws a
// plain Error, NOT a SandbarError: SandbarError means "operator-actionable,
// do not retry" and the inner loop rethrows it past HARD-ERROR, which would
// drop the issue for the cycle with no terminal and no finalize. Podman
// failing to create a network is infrastructure — the fresh-stack retry is
// exactly what it wants.
async function mustSucceed(
  args: readonly string[],
  what: string,
): Promise<BoundedResult> {
  const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
  if (boundedOk(r)) return r;
  throw new Error(
    `gate stack: could not ${what}: ${
      r.timedOut
        ? `${RUNTIME} ${args[0]} did not return within ${CONTROL_TIMEOUT_MS}ms`
        : r.errorMessage
    }`,
  );
}

export const READY_POLL_INTERVAL_MS = 500;

// How many `.State.Health.Log` entries a bringup failure carries. Podman keeps
// five by default, which is the number this matches, but retention is a host
// setting (`--health-max-log-count`, containers.conf) — so this is SANDBAR's
// cap and the trace is sliced to it, rather than a restatement of podman's that
// a configured host would quietly falsify.
export const HEALTH_LOG_ENTRIES = 5;

// Public resolvers on the pod, so external name resolution survives the
// `--disable-dns` network (#18). `--dns` writes resolv.conf directly, bypassing
// the (absent) aardvark resolver; pod members inherit it.
const DNS_SERVERS: readonly string[] = ["1.1.1.1", "8.8.8.8"];

// Lines of each container's log appended to a red gate's trace (#24 D9), and
// the tail shown when a container dies during bringup.
export const CONTAINER_LOG_TAIL = 40;

// Bound for the podman calls sandbar makes ABOUT a container rather than
// through it — `logs`, `inspect`. These answer from local state and are fast or
// broken; the point is only that none of them can hang the run. Consumer-facing
// execs are bounded by the readiness budget instead.
export const LOG_READ_TIMEOUT_MS = 15_000;

// Bound for the podman calls that CREATE and DESTROY things — `pod create`,
// `network create`, `run`, `rm`, `pod rm`. Separate from LOG_READ_TIMEOUT_MS
// and much larger, because these do real work (unpacking layers, setting up
// overlay mounts, tearing down namespaces) and a host running three stacks in
// parallel can legitimately take tens of seconds. 15s here would be a spurious
// bringup failure, which is a false verdict about a branch.
//
// They are bounded at all because the alternative is #26's hang reached through
// #26's own fix: `reapTimedOutStep` tolerates a failed remove on the grounds
// that the next gate run force-removes the container before recreating it, so
// an unbounded remove THERE would hang the run forever holding the lock.
export const CONTROL_TIMEOUT_MS = 120_000;

// The one env key sandbar owns in the stack. Everything else a step needs —
// DB_HOST, credentials, ports — is now literal config the consumer writes,
// because with one namespace `127.0.0.1` is an address it can know up front.
const RESERVED_ENV: Readonly<Record<string, string>> = { CI: "true" };

// `-t 0` kills immediately instead of waiting out podman's default 10-second
// graceful stop PER CONTAINER. Nothing in a gate stack has state worth
// flushing — the containers are recreated from the image every attempt — and
// paying 10s a container on every teardown is real wall-clock across three
// parallel issues and eight attempts each.
const POD_RM_ARGS = (podName: string): string[] => [
  "pod",
  "rm",
  "-f",
  "-t",
  "0",
  podName,
];

export type StackOptions = {
  // Issue id in the inner loop, "merger" for gate-2.
  readonly stackId: string;
  // This run's resource scope (#28). Every name below is built under it, so a
  // concurrent run against a different workdir cannot be a namesake — the
  // `pod rm -f` that recycles a stale pod below would otherwise be reaching
  // into a live sibling's stack.
  readonly scope: RunScope;
  readonly spec: ResolvedGateStack;
  // The worktree the gate is a verdict about. Must exist, with its files, before
  // this call — bind-mount sources are read at container start.
  readonly worktreePath: string;
  // Which image each container should actually run, for THIS worktree as it is
  // right now (#37). Called at the top of every gate run, never cached: an
  // image that bakes a lockfile is a function of the branch, and the branch
  // grows between attempts — an implementer that adds a dependency in attempt 2
  // must be gated against an image that has it.
  //
  // Omitted, every container runs the image its config names, which is what
  // every stack without a `rebuildOn` image does.
  //
  // The argument is the set of declared tags THIS stack runs, computed here
  // from the spec rather than by the caller (#46). The resolver is shared with
  // the agent sandbox, and asking it about an entry no container in this stack
  // runs would pay for a build the gate cannot use and let that build's failure
  // red a gate it has nothing to do with.
  readonly images?: (only: ReadonlySet<string>) => Promise<ImageMap>;

  // -------------------------------------------------------------------------
  // The standalone `sandbar gate` (#45). Every field below is omitted by every
  // caller inside a run, and each one is a deliberate exception to a rule this
  // module states elsewhere — so they are named for what they suspend, not for
  // what they enable.
  // -------------------------------------------------------------------------

  // Reuse an `issue`-lifecycle container that is still running from a previous
  // invocation, instead of recreating it — the half of #45 that makes
  // `sandbar gate` as fast as the bash script it replaces (its database survives
  // between runs). Inside a run the question never arises: a stack is created
  // and destroyed with its issue, so there is never a predecessor.
  //
  // The token is what makes the reuse SOUND rather than merely fast. It is
  // recorded on the pod at creation and compared here, so a stack whose config
  // has changed since — a new env var on the database, a different mount, a
  // renamed step — is torn down and rebuilt rather than silently gating against
  // the container the old config described. `gate-run.ts` derives it from the
  // resolved spec; this module only carries it. A mismatch, an unreadable
  // label, or a pod that predates the label all mean "recreate", which is only
  // ever slower.
  //
  // What it does NOT cover is the image: a reused container may be running a
  // tag the branch has since moved. That is `runGate`'s existing staleness
  // check, which recreates it — `startStack` seeds `running.map` from what the
  // reused containers are ACTUALLY running so that check has something true to
  // compare against.
  readonly reuseToken?: string | undefined;

  // Leave the whole stack up when `stop()` is called, so an operator can poke
  // at a red gate's containers (`GATE_KEEP=true` in the script #45 deletes).
  // `stop` stays registered with `onCleanup` and stays idempotent; it simply
  // removes nothing, which is what makes a Ctrl-C mid-gate keep the stack too —
  // the state the operator asked to be able to inspect.
  readonly keepAlive?: boolean;

  // Skip D1's dirty-worktree refusal.
  //
  // D1 refuses to gate a tree that is not its HEAD because a verdict inside the
  // loop is about a COMMIT: the merger only ever sees commits, so a green over
  // uncommitted work certifies something no merge can contain. A standalone
  // gate has no merger and no commit — the operator is asking about the tree in
  // front of them, which on a laptop is the tree with their edits in it. Keep
  // the refusal there and `sandbar gate` cannot replace `scripts/gate.sh` at
  // all, since the first thing anyone runs it on is work in progress.
  //
  // The distinction is not dropped, only moved: `gate-run.ts` reports the dirty
  // paths and says the verdict is about the working tree. Nothing inside a run
  // may pass this.
  readonly allowDirtyWorktree?: boolean;

  // Tee each step's output as it arrives (see `boundedPodman`). Absent, output
  // is captured only, which is what a run wants — its steps report through the
  // attempt log and a gate trace, and nobody is watching a terminal.
  readonly onStepOutput?: (chunk: string) => void;
};

export type Stack = {
  readonly podName: string;
  readonly networkName: string;
  // Which containers this call adopted from a previous invocation rather than
  // creating, by their configured names (#45). Always empty without
  // `reuseToken`. Reported by the caller, because "your database is 40 minutes
  // old" is exactly what an operator debugging a surprising verdict needs to be
  // told without having to ask podman.
  readonly reused: readonly string[];
  // Recreate the attempt-lifecycle containers and run every step in order.
  readonly runGate: () => Promise<GateResult>;
  readonly stop: () => Promise<void>;
};

// A container failed to start or never became ready. Thrown for `issue`
// containers (infra → HARD-ERROR); caught and converted to a red gate for
// `attempt` ones.
//
// `healthLog` is ADDED to the container log tail rather than replacing it
// (#43). The health log says what the PROBE saw, which is what the tail cannot
// tell you; D9's argument runs the other way as well, since why a probe failed
// is usually in the service's own output.
//
// Only the readiness TIMEOUT fills it in. Most bringup failures happen before
// or beside the probe and have no entries to show, so a heading there would
// stand over nothing — but one does not: `throwIfDead` reached from inside the
// readiness poll is a container that failed probes and THEN exited, and its
// entries exist. That omission is a deliberate small loss, not an oversight. A
// container that dies during startup is diagnosed by its own log, which that
// error already carries in full, and the alternative is an `inspect` on the
// path where podman has just told us the container is stopped or gone.
export class ContainerBringupError extends SandbarError {
  readonly containerName: string;
  readonly logTail: string;
  readonly healthLog: string;
  constructor(
    containerName: string,
    message: string,
    logTail: string,
    healthLog = "",
  ) {
    super(
      `${message}\n` +
        // No count in the heading: a container that failed twice has two
        // entries, so "last 5 probes" over two lines would be a small lie in
        // exactly the place someone is counting — and the caller, not this
        // heading, is what bounds the list to HEALTH_LOG_ENTRIES.
        (healthLog
          ? `Container health log (most recent probes, oldest first):\n` +
            `${healthLog}\n`
          : "") +
        `Container log tail:\n${logTail}`,
    );
    this.name = "ContainerBringupError";
    this.containerName = containerName;
    this.logTail = logTail;
    this.healthLog = healthLog;
  }
}

// ---------------------------------------------------------------------------
// Pure argv builders — the real adapters' blind spot is that a fake satisfies
// the contract no matter what argv the real one builds, so these are separated
// out and table-tested (gate-stack.test.ts).
// ---------------------------------------------------------------------------

// One `-v` spec. Relative hostPaths resolve against the gated worktree;
// absolute pass through. Read-only unless the mount says `mode: "rw"`, always
// `z`-relabelled: without the SELinux label the mount is denied outright on
// Fedora/RHEL/CentOS, which is what `agent-sandbox.ts` has always done and what
// the pre-#24 gate and sidecar mounts did not. The mode is read off the
// RESOLVED mount rather than defaulted here, so "what does an omitted mode
// mean" is answered in exactly one place (`resolveGateStack`).
export function mountSpec(
  worktreePath: string,
  mount: ResolvedStackMount,
): string {
  const hostPath = isAbsolute(mount.hostPath)
    ? mount.hostPath
    : resolvePath(worktreePath, mount.hostPath);
  return `${hostPath}:${mount.containerPath}:${mount.mode},z`;
}

// No `-p` at all, and since #43 that is unconditional: `tcp` readiness was the
// only thing that ever made a gate pod publish anything, and the probe now runs
// inside the container. "Publishes no fixed ports" lost its asterisk.
export function podCreateArgs(opts: {
  readonly podName: string;
  readonly networkName: string;
  // The reuse token (#45), recorded on the pod so a later invocation can ask
  // whether the stack still up is the stack its config describes. Omitted for
  // every stack inside a run, which is torn down with the issue and has nothing
  // to reuse.
  readonly reuseToken?: string | undefined;
}): string[] {
  return [
    "pod",
    "create",
    "--name",
    opts.podName,
    "--network",
    opts.networkName,
    ...DNS_SERVERS.flatMap((s) => ["--dns", s]),
    ...(opts.reuseToken === undefined
      ? []
      : ["--label", `${REUSE_TOKEN_LABEL}=${opts.reuseToken}`]),
  ];
}

// The pod label carrying the reuse token (#45).
export const REUSE_TOKEN_LABEL = "sandbar.stack";

// Read one label off an existing pod, from `podman pod inspect`'s JSON.
//
// A pure parser rather than an `--format` template, and both halves of that are
// deliberate. Podman's `pod inspect` has returned a bare OBJECT (4.x) and an
// ARRAY of one (5.x) across the versions sandbar is used on, so the shape is
// something to accept rather than assume; and this answer decides whether a
// live database is REUSED or torn down, so it degrades to null — recreate,
// which is only ever slower — for anything it does not recognise, exactly as
// `parseHealthLog` degrades to no health block.
export function parsePodLabel(json: string, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim());
  } catch {
    return null;
  }
  const one = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof one !== "object" || one === null) return null;
  const labels = (one as { Labels?: unknown }).Labels;
  if (typeof labels !== "object" || labels === null) return null;
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

// The `run` flags that register a readiness probe podman will evaluate on
// demand (#43). Both flags or neither: `--health-interval=disable` is IGNORED
// unless a `--health-cmd` accompanies it, so the pair is what suppresses the
// transient systemd timer, and a container with no readiness must register no
// check at all (nothing would ever invoke it, and the timer would be the only
// thing the flags achieved).
//
// JSON argv, so podman stores it as `["CMD", …]` and runs it directly. A string
// would be wrapped in `CMD-SHELL` and re-split by a shell, which is the
// quoting-dialect problem `step.command` and `postReadyCommands` avoid by being
// argv everywhere else in this config.
//
// No `--health-timeout`, no `--health-retries`, no `--health-start-period`.
// The last two are podman's status-TRANSITION bookkeeping and have no effect on
// `healthcheck run`'s exit code, which is the only thing sandbar reads, so they
// would be config that does nothing. `--health-timeout` is worse than inert —
// see the header: it does not kill.
export function healthCheckArgs(c: ResolvedStackContainer): string[] {
  if (c.readiness === null) return [];
  return [
    "--health-cmd",
    JSON.stringify(c.readiness.command),
    "--health-interval=disable",
  ];
}

// How a container gets its network namespace, and the only thing #44 had to
// generalise in this module.
//
// `pod` is the gate's own topology and everything the header says about it
// stands. `netns` is the anchor chain — `--network container:<anchor>` — and it
// exists for exactly one caller, the sandbox stack (sandbox-stack.ts), where
// the argument the header makes AGAINST the chain inverts: the anchor there is
// the agent container, which is created first, outlives every sibling and is
// never recreated per attempt. A pod is unavailable to it for a hard podman
// reason (`--pod` refuses `--userns=keep-id`, and the agent must keep it), so
// the chain is not a docker tax there but the only shape available.
//
// The joiner takes NO `-p` and NO `--dns`: podman refuses both alongside
// `--network container:`, since those are properties of the namespace and the
// namespace belongs to the anchor. Since #43 that is the whole of the chain's
// tax and it costs nothing, because neither flag has a caller left. Nothing
// publishes: the readiness probe runs INSIDE the container (`podman
// healthcheck run`), so a joiner needs no host port any more than a pod member
// does. And the `--dns` servers above exist to survive this module's
// `--disable-dns` network (#18), while the agent container sits on podman's
// default one with its resolver intact — the joiners inherit that.
export type ContainerAttachment =
  | { readonly kind: "pod"; readonly podName: string }
  | { readonly kind: "netns"; readonly anchorContainerName: string };

// What this module's own stack is called in the messages it raises. The sandbox
// stack passes its own (`BringUpCtx.label`), which is the only reason this is a
// value at all.
const GATE_LABEL = "gate stack";

export function containerRunArgs(opts: {
  readonly containerName: string;
  readonly attach: ContainerAttachment;
  readonly container: ResolvedStackContainer;
  readonly worktreePath: string;
}): string[] {
  const { container: c } = opts;
  const args = [
    "run",
    "-d",
    "--name",
    opts.containerName,
    ...(opts.attach.kind === "pod"
      ? ["--pod", opts.attach.podName]
      : ["--network", `container:${opts.attach.anchorContainerName}`]),
    "--label",
    "sandbar=true",
    // Consumer env first, sandbar's reserved key last: podman keeps the final
    // value for a repeated -e, so the reserved key wins.
    ...Object.entries(c.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.entries(RESERVED_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...c.mounts.flatMap((m) => ["-v", mountSpec(opts.worktreePath, m)]),
    ...healthCheckArgs(c),
  ];
  if (c.mountWorktree !== null) {
    args.push("-v", `${opts.worktreePath}:${c.mountWorktree}:rw,z`);
    args.push("-w", c.mountWorktree);
  }
  if (c.hold) {
    // No `--user`/`--userns`: neither is available in a pod, the image's
    // default user is what the uid preflight checked, and a `netns` joiner
    // deliberately runs the same way — its worktree writes have to land as the
    // invoking user, which under rootless podman is what container root maps
    // to, exactly as in the pod.
    args.push("--entrypoint", "sleep", c.image, "infinity");
  } else {
    args.push(c.image, ...c.args);
  }
  return args;
}

// The image a container should run under a given map (#37). An unmapped
// container runs exactly what its config names, which is every container in
// every stack that declares no `rebuildOn` image.
export function imageFor(
  container: ResolvedStackContainer,
  map: ImageMap,
): string {
  return map.get(container.image) ?? container.image;
}

// The container specs as they should actually run, with images substituted
// where the branch changed one. A pure remap rather than an extra argument on
// every call: `containerRunArgs`, the readiness probes and the bringup error
// messages all read `c.image`, and threading an override past each of them is
// four chances to leave one reading the declared tag.
export function withImages(
  containers: readonly ResolvedStackContainer[],
  map: ImageMap,
): readonly ResolvedStackContainer[] {
  if (map.size === 0) return containers;
  return containers.map((c) => {
    const mapped = map.get(c.image);
    return mapped === undefined || mapped === c.image
      ? c
      : { ...c, image: mapped };
  });
}

export function stepExecArgs(
  containerName: string,
  command: readonly string[],
): string[] {
  return [
    "exec",
    ...Object.entries(RESERVED_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    containerName,
    ...command,
  ];
}

// One recorded probe invocation, out of `.State.Health.Log`.
//
// `exitCode` is what PODMAN recorded, which is not what the probe returned: a
// probe exiting 3 is normalised to 1, and a probe podman decided had exceeded
// `--health-timeout` is recorded as -1 (having been allowed to run to
// completion first). Carried verbatim rather than re-interpreted — the whole
// value of the block is that it is podman's own record.
export type HealthLogEntry = {
  readonly start: string;
  readonly exitCode: number;
  readonly output: string;
};

// Parse `podman inspect --format '{{json .State.Health}}'`. Shape:
//   {"Status":"starting","FailingStreak":2,
//    "Log":[{"Start":"…","End":"…","ExitCode":1,"Output":"…"}]}
//
// Total, never throwing, and that is deliberate: this feeds an error message
// that is already being raised about something else, so a shape sandbar did not
// expect must degrade to "no health block" rather than replace a readiness
// timeout with a JSON parse error. `Log` is `null` for a container that has a
// check registered but has never been probed, and `.State.Health` itself is a
// zero-valued struct for one with no check at all.
export function parseHealthLog(json: string): HealthLogEntry[] {
  const trimmed = json.trim();
  if (!trimmed || trimmed === "null") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const log = (parsed as { Log?: unknown }).Log;
  if (!Array.isArray(log)) return [];
  const out: HealthLogEntry[] = [];
  for (const raw of log) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as { Start?: unknown; ExitCode?: unknown; Output?: unknown };
    out.push({
      start: typeof e.Start === "string" ? e.Start : "",
      exitCode: typeof e.ExitCode === "number" ? e.ExitCode : NaN,
      output: typeof e.Output === "string" ? e.Output : "",
    });
  }
  return out;
}

// The health log as it goes into a bringup error. Oldest first, which is the
// order podman stores it in and the order it reads in: a probe's output is
// usually a progression ("connect failed" → "connect failed" → the real error).
export function formatHealthLog(entries: readonly HealthLogEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((e) => {
      const head = `  ${e.start || "(no timestamp)"} exit ${
        Number.isNaN(e.exitCode) ? "?" : String(e.exitCode)
      }`;
      const body = stripAnsi(e.output).trim();
      return body ? `${head}\n${indent(body)}` : `${head} (no output)`;
    })
    .join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startStack(opts: StackOptions): Promise<Stack> {
  const networkName = networkNameFor(opts.scope, opts.stackId);
  const podName = podNameFor(opts.scope, opts.stackId);
  const nameOf = (c: ResolvedStackContainer): string =>
    stackContainerNameFor(opts.scope, opts.stackId, c.name);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // `--keep` (#45). Registered and idempotent exactly as before, so nothing
    // about the cleanup contract changes — this teardown simply has nothing to
    // do. Placed after the `stopped` latch rather than before the registration
    // so a signal still runs the action and still finds it already spent.
    if (opts.keepAlive === true) return;
    // `pod rm -f` takes the member containers AND the infra container with it.
    // The infra container is named `<pod-id-prefix>-infra`, which matches no
    // sandbar prefix — removing containers by name would leave it, and the pod,
    // behind.
    //
    // Failures here are NOT swallowed. A `pod rm` that fails leaks the pod, its
    // members, that unreachably-named infra container and its network, and the
    // only backstop (`cleanupOrphanContainers`) does not run until the top of
    // the next cycle — so on the last cycle, or on any halt, the leak outlives
    // the process. `-f` on the network too, matching the create path: at this
    // point the pod is meant to be gone and a lingering endpoint is exactly
    // what needs forcing.
    //
    // Bounded through `boundedPodman`, not node's `timeout:` — this is the
    // same green-on-red as everywhere else in this module and it lands
    // precisely on the claim above: node SIGTERMs, podman exits 0, the failure
    // list stays empty, and sandbar reports a clean teardown of a pod that is
    // still running.
    const failures: string[] = [];
    const attempt = async (args: string[]): Promise<void> => {
      const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
      if (boundedOk(r)) return;
      failures.push(
        `  ${RUNTIME} ${args.join(" ")}\n    ${
          r.timedOut
            ? `timed out after ${CONTROL_TIMEOUT_MS}ms`
            : r.errorMessage
        }`,
      );
    };
    await attempt(POD_RM_ARGS(podName));
    await attempt(["network", "rm", "-f", networkName]);
    if (failures.length > 0) {
      throw new SandbarError(
        `gate stack: teardown of pod '${podName}' / network '${networkName}' ` +
          `failed, leaking podman resources:\n${failures.join("\n")}\n` +
          `Clean up with: ${RUNTIME} ${POD_RM_ARGS(podName).join(" ")} && ` +
          `${RUNTIME} network rm -f ${networkName}`,
      );
    }
  };
  // Registered before the first resource exists, so a signal anywhere in the
  // bringup window below still sweeps whatever was created. The local catch
  // only fires for JS throws; signal-driven exit does not unwind it. `stop` is
  // idempotent and best-effort, so an early registration is safe.
  onCleanup(stop);

  try {
    // Is there a stack up that this call may adopt (#45)? Only ever true for a
    // standalone `sandbar gate`, which passes a token; every stack inside a run
    // skips straight to the recreate below.
    //
    // The token has to be compared BEFORE the `pod rm -f`, because that line is
    // what a reuse has to avoid, and it is asked of the POD rather than of the
    // containers: the pod is the one resource that outlives every member, so it
    // is the only honest place to record what config the members were created
    // from.
    const reusing =
      opts.reuseToken !== undefined &&
      (await podReuseToken(podName)) === opts.reuseToken;

    if (!reusing) {
      // A namesake surviving an older run may be DNS-enabled or otherwise stale
      // and must never be reused. `rm -f` no-ops when absent, so this is the
      // recreate-once migration and the first-time create in one step.
      //
      // "an older run" is only true because the name carries `opts.scope` (#28).
      // Unscoped, the only namesake a second run against a different repo could
      // find for issue 42 was the FIRST run's live pod, and this line tore it
      // down — the victim just watched its containers disappear mid-gate.
      await boundedPodman(POD_RM_ARGS(podName), CONTROL_TIMEOUT_MS);
      await boundedPodman(
        ["network", "rm", "-f", networkName],
        CONTROL_TIMEOUT_MS,
      );
      await mustSucceed(
        ["network", "create", "--disable-dns", networkName],
        `create network ${networkName}`,
      );
      await mustSucceed(
        podCreateArgs({ podName, networkName, reuseToken: opts.reuseToken }),
        `create pod ${podName}`,
      );
    }

    const attach: ContainerAttachment = { kind: "pod", podName };

    const issueContainers = opts.spec.containers.filter(
      (c) => c.lifecycle === "issue",
    );
    // Split only under reuse; otherwise the pod was just created and nothing
    // can be running in it. `running` here means podman says so — a stopped or
    // removed one is rebuilt, which is the answer
    // `assertIssueContainersAlive` would give a moment later anyway, reached
    // while it can still be acted on. `unknown` counts as NOT reusable, and
    // that asymmetry with every other reader of that state (which treats it as
    // no evidence and defers) is deliberate: there the cost of being wrong is a
    // HARD-ERROR storm, here it is one container recreated.
    //
    // The SPLIT is for bringup alone. `runStackGate` keeps the whole list, so a
    // reused container is liveness-checked and staleness-checked exactly like
    // one this call started — the reuse is a claim about who created it, never
    // an exemption from the checks.
    const reused: ResolvedStackContainer[] = [];
    const freshIssueContainers: ResolvedStackContainer[] = [];
    for (const c of issueContainers) {
      if (reusing && (await containerState(nameOf(c))) === "running") {
        reused.push(c);
      } else {
        freshIssueContainers.push(c);
      }
    }
    // Brought up with the images config NAMES, deliberately, even when some of
    // them are `rebuildOn` images the branch may already have changed (#37).
    // Resolving here would put a per-branch build — which can fail because of
    // the branch — outside every gate run, where its only exit is a throw, i.e.
    // HARD-ERROR: two fresh-stack retries reproducing the same broken lockfile
    // and then `agent-stuck` with an "environment" trace. Leaving it to the
    // first `runGate` gives that failure the one exit that names the branch,
    // and costs at most one extra container start on a resumed issue.
    //
    // Nothing of the branch runs at this point in any case: `resolveGateStack`
    // refuses `lifecycle: "issue"` on an un-held container that mounts the
    // worktree, and a held one's entrypoint is `sleep infinity`.
    await bringUpContainers(freshIssueContainers, {
      attach,
      label: GATE_LABEL,
      worktreePath: opts.worktreePath,
      nameOf,
    });

    // A reused container is not re-created, but it IS re-probed (#45). Its
    // `postReadyCommands` are deliberately not re-run — they are one-shot setup
    // per container, and re-running the migration that made the reuse worth
    // having is the whole cost the reuse exists to avoid — but "it was ready an
    // hour ago" is not evidence that it is ready now: the host may have
    // suspended, the service may have wedged. One `podman healthcheck run` is
    // cheap and is the same question bringup asks.
    //
    // A probe that fails here raises `ContainerBringupError` from the shared
    // poll, which for an `issue` container is D5's infra throw — correct, and
    // it lands on the standalone gate's non-verdict exit rather than on a red.
    for (const c of reused) {
      await waitForReady(nameOf(c), c, GATE_LABEL);
    }

    const attemptContainers = opts.spec.containers.filter(
      (c) => c.lifecycle === "attempt",
    );

    // What the long-lived containers are currently running, as a tag->tag map
    // in the same shape `opts.images` returns. Mutable and owned by the stack:
    // it is how `runGate` knows which issue containers a changed image leaves
    // stale, and the empty map above is the honest starting value.
    //
    // Honest only for containers THIS call created. A reused one was created by
    // an earlier invocation, possibly from a per-branch variant tag, so its
    // entry is read back off podman (#45) — an empty map would claim it is on
    // the declared tag, which either recreates a perfectly good container every
    // invocation or, worse, agrees with a declared tag it is not running.
    const running: { map: ImageMap } = {
      map: await runningImages(reused, nameOf),
    };
    const imageResolver = opts.images;
    // Computed here, from this stack's own spec, so no caller can hand the
    // shared resolver a superset (#46).
    const imagesThisStackRuns = new Set(opts.spec.containers.map((c) => c.image));

    return {
      podName,
      networkName,
      reused: reused.map((c) => c.name),
      stop,
      runGate: () =>
        runStackGate({
          spec: opts.spec,
          attemptContainers,
          issueContainers,
          attach,
          worktreePath: opts.worktreePath,
          nameOf,
          images: imageResolver
            ? () => imageResolver(imagesThisStackRuns)
            : async () => new Map(),
          running,
          allowDirtyWorktree: opts.allowDirtyWorktree === true,
          onStepOutput: opts.onStepOutput,
        }),
    };
  } catch (err) {
    // The bringup failure is the diagnosis; a teardown failure on top of it is
    // reported but must not replace it.
    await stop().catch((stopErr: unknown) => {
      console.error(
        stopErr instanceof Error ? stopErr.message : String(stopErr),
      );
    });
    throw err;
  }
}

// The container's recorded probe history, for a bringup error. Read ONCE, at
// the readiness deadline, rather than on every failed poll: podman is already
// keeping the recent entries for us (five by default), so the read at the
// deadline sees the right window and a per-poll read would buy nothing but a
// podman call every 500ms.
//
// Never throws, and returns "" for everything it cannot answer. This runs on a
// path where a `ContainerBringupError` is already being raised — that error is
// the diagnosis, and losing it to a flaked `inspect` while assembling an
// addendum to it would be a strictly worse outcome than an error with no health
// block.
// The reuse token recorded on an existing pod (#45), or null for a pod that is
// absent, unreadable, or predates the label.
//
// Never throws and never distinguishes its failures, because every one of them
// has the same consequence: the pod is force-removed and the stack rebuilt,
// which is what would have happened without a token at all. A reuse that cannot
// prove itself is not a reuse.
async function podReuseToken(podName: string): Promise<string | null> {
  const r = await boundedPodman(
    ["pod", "inspect", podName],
    LOG_READ_TIMEOUT_MS,
  );
  if (!boundedOk(r)) return null;
  return parsePodLabel(r.stdout, REUSE_TOKEN_LABEL);
}

// What the reused containers are actually running, as the declared-tag ->
// running-tag map `runGate`'s staleness check compares against (#45).
//
// An UNMAPPED container means "running what its config names", which is the
// same convention `imageFor` uses everywhere else and the honest answer for
// every reused container the tree has not moved under. A mapping is recorded
// only when the container is on something else — a per-branch variant an
// earlier invocation built — and that is exactly what makes the staleness check
// recreate it.
//
// `.Config.Image` is the reference the container was CREATED from: the same
// string `containerRunArgs` put on the command line, which is what the check
// compares against. But podman is free to answer in a spelling the config did
// not use, and an unqualified `mariadb:10.11` coming back
// `docker.io/library/mariadb:10.11` would make every reused container look
// stale and be recreated — reuse defeated, silently, by a string comparison.
// So a difference in the STRING is settled by comparing image IDs before it is
// believed. Anything unreadable contributes nothing and therefore recreates:
// wrong only in the direction that costs time.
async function runningImages(
  reused: readonly ResolvedStackContainer[],
  nameOf: (c: ResolvedStackContainer) => string,
): Promise<ImageMap> {
  const map = new Map<string, string>();
  for (const c of reused) {
    const r = await boundedPodman(
      ["inspect", "--format", "{{.Config.Image}}", nameOf(c)],
      LOG_READ_TIMEOUT_MS,
    );
    if (!boundedOk(r)) continue;
    const image = r.stdout.trim();
    if (!image || image === c.image) continue;
    if (!(await sameImage(image, c.image))) map.set(c.image, image);
  }
  return map;
}

// Do two references name the same image right now? Used only to stop a
// spelling difference from reading as staleness (#45). A reference podman
// cannot resolve — a tag removed since the container was created — answers
// false, which is both true and the safe direction.
async function sameImage(a: string, b: string): Promise<boolean> {
  const idOf = async (ref: string): Promise<string | null> => {
    const r = await boundedPodman(
      ["image", "inspect", "--format", "{{.Id}}", ref],
      LOG_READ_TIMEOUT_MS,
    );
    if (!boundedOk(r)) return null;
    return r.stdout.trim() || null;
  };
  const idA = await idOf(a);
  return idA !== null && idA === (await idOf(b));
}

async function readHealthLog(
  containerName: string,
): Promise<HealthLogEntry[]> {
  const r = await boundedPodman(
    ["inspect", "--format", "{{json .State.Health}}", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  if (!boundedOk(r)) return [];
  return parseHealthLog(r.stdout);
}

// The text the readiness timeout puts in its `last probe:` slot.
//
// Ordinarily the health log, not the client's own output, and that is the
// difference between a useful message and a worse one than this replaced:
// `podman healthcheck run` prints the single word `unhealthy` on failure, so a
// detail built from its stdout says nothing about what the probe saw.
//
// `clientTimedOut` overrides that, and it is the one thing the health log
// CANNOT say. A probe killed at the deadline records no entry — the client died
// before podman wrote one — so the newest entry belongs to some earlier, faster
// failure. Rendering it would report "exit 1: connect failed" for a probe that
// in fact stopped returning, which is the #31 misdirection ("pattern not in log
// yet" over a buffer wall) rebuilt in the replacement for it: the operator is
// sent to debug a connection error that is not what happened. Since sandbar's
// own deadline is the ONLY bound on a probe — podman's `--health-timeout` does
// not kill — the kill is exactly the fact worth reporting, so it is reported
// first and the stale entry is offered after it as context rather than as the
// verdict.
export function lastProbeText(
  entries: readonly HealthLogEntry[],
  clientDetail: string,
  clientTimedOut: boolean,
): string {
  const last = entries[entries.length - 1];
  const recorded = last === undefined ? "" : describeHealthEntry(last);
  if (clientTimedOut) {
    const detail = clientDetail || "probe was killed at the deadline";
    return recorded ? `${detail} (previous probe: ${recorded})` : detail;
  }
  return recorded || clientDetail || "no probe was recorded";
}

function describeHealthEntry(e: HealthLogEntry): string {
  const output = stripAnsi(e.output).trim();
  const code = Number.isNaN(e.exitCode) ? "?" : String(e.exitCode);
  return output ? `exit ${code}: ${output}` : `exit ${code}, no output`;
}

// Exported since #44: the sandbox stack brings its siblings up through exactly
// this, so the readiness probes, the liveness asserts and the postReadyCommands
// discipline exist once rather than twice. `attach` is the only thing that
// differs between the two callers.
export type BringUpCtx = {
  readonly attach: ContainerAttachment;
  // Which stack this is, for the messages raised below — `gate stack` or
  // `sandbox stack`. A field rather than something derived from `attach.kind`,
  // even though the two agree today, because they answer different questions:
  // one is a topology, the other is whose failure this is. Derive it and the
  // day a gate needs a chain every gate message names the sandbox.
  //
  // It is not cosmetic. The one string D3 hands a degraded `attempt` sibling is
  // this message, rendered into the implementer's prompt directly under a
  // paragraph telling the agent the gate's stack is a namespace it cannot
  // reach — so a `gate stack:` prefix there reads as a red gate that never ran,
  // against a stack the agent has just been told not to touch. The operator's
  // half is the same error one arm along: an `issue` sibling's throw surfaces
  // as the HARD-ERROR reason, sending whoever reads the run log to inspect a
  // pod where nothing is wrong.
  readonly label: string;
  readonly worktreePath: string;
  // Passed as a closure rather than rebuilt from (scope, stackId) here: the
  // name is the stack's identity, and one place composes it.
  readonly nameOf: (c: ResolvedStackContainer) => string;
};

// Start every container, THEN wait for all of them, then run their post-ready
// setup. Started together because a container only needs the pod to exist, not
// its neighbours to be ready — there is no reason for a frontend that builds
// the app on startup to queue behind a database initialising a schema it never
// reads.
export async function bringUpContainers(
  containers: readonly ResolvedStackContainer[],
  ctx: BringUpCtx,
): Promise<void> {
  for (const c of containers) {
    const containerName = ctx.nameOf(c);
    // A container of this name may survive a crashed run; the sweep covers the
    // usual case but the pod was just recreated, so any leftover is stale.
    //
    // Bounded, and that bound is load-bearing rather than tidy: this remove is
    // the fallback `reapTimedOutStep` leans on when its own remove fails, so an
    // unbounded one here would turn a red gate into a run that hangs forever.
    await boundedPodman(
      ["rm", "-f", "-t", "0", containerName],
      CONTROL_TIMEOUT_MS,
    );
    const started = await boundedPodman(
      containerRunArgs({
        containerName,
        attach: ctx.attach,
        container: c,
        worktreePath: ctx.worktreePath,
      }),
      CONTROL_TIMEOUT_MS,
    );
    if (!boundedOk(started)) {
      throw new ContainerBringupError(
        containerName,
        `${ctx.label}: container '${c.name}' (${c.image}) failed to start: ${
          started.timedOut
            ? `${RUNTIME} run did not return within ${CONTROL_TIMEOUT_MS}ms`
            : started.errorMessage
        }`,
        await logTail(containerName),
      );
    }
  }

  for (const c of containers) {
    await waitForReady(ctx.nameOf(c), c, ctx.label);
  }

  for (const c of containers) {
    const containerName = ctx.nameOf(c);
    for (const command of c.postReadyCommands) {
      // Bounded by the container's readiness budget: post-ready setup is
      // bringup, and an unbounded exec here hangs the run holding the lock
      // exactly as a hung probe would. `CI=true` is passed for the same
      // reason steps get it — a migration or seed script that branches on it
      // must not see a different environment than the steps that follow.
      const r = await boundedPodman(
        stepExecArgs(containerName, command),
        c.readinessTimeoutMs,
      );
      if (boundedOk(r)) continue;
      // Post-ready setup is part of the container's contract — a failing
      // command means every step runs against a half-initialized service. A
      // command that HANGS is the same thing and used to be worse than a slow
      // one: with node's `timeout:` doing the killing, a seed script that
      // never returned was reported as having succeeded.
      throw new ContainerBringupError(
        containerName,
        `${ctx.label}: postReadyCommand ${JSON.stringify(command)} ` +
          (r.timedOut
            ? `did not finish within the container's ${c.readinessTimeoutMs}ms ` +
              `readiness budget and was killed, in container '${c.name}'. ` +
              "Raise `readinessTimeoutMs` if the setup is genuinely this slow." +
              // Only on this branch: node's own message already ends with the
              // command's stderr, so appending it to the non-timeout branch
              // would print the failure twice.
              (r.stderr.trim() ? `\n${stripAnsi(r.stderr).trim()}` : "")
            : `failed in container '${c.name}': ${r.errorMessage}`),
        await logTail(containerName),
      );
    }
  }
}

// Milliseconds left before `deadline`, floored at 1. The floor mattered more
// when this fed node's `timeout:` option, which reads 0 as "no timeout"; it now
// feeds `boundedPodman`'s own `setTimeout`, where 0 and 1 are both "next tick".
// Kept because a probe budget is meaningfully expressed as at-least-one-tick
// and a 0 would invite the old reading back.
function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function waitForReady(
  containerName: string,
  c: ResolvedStackContainer,
  label: string,
): Promise<void> {
  if (c.readiness === null) {
    // No probe was declared, so nothing else ever looks at this container: the
    // loop below is the only site that would, and `throwIfDead` is reachable
    // only from inside it. Skip that and a container whose entrypoint dies at
    // startup passes bringup — `podman run -d` exits 0 for it — and its death
    // is then charged to the branch by every step that talks to it, which is
    // D5's blame mapping running backwards. One grace interval (the container
    // has to get far enough to fail) and then the same liveness assert every
    // probed container gets.
    await sleep(READY_POLL_INTERVAL_MS);
    await throwIfDead(containerName, c, label);
    return;
  }
  // No `finally` and nothing to own: since #43 the probe is a bounded
  // `execFile` like every other podman call here, rather than a `podman logs
  // -f` follower whose only bound was this function holding it.
  await pollUntilReady(containerName, c, c.readiness, label);
}

async function pollUntilReady(
  containerName: string,
  c: ResolvedStackContainer,
  readiness: NonNullable<ResolvedStackContainer["readiness"]>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + c.readinessTimeoutMs;
  let lastErr = "";
  // Tracked beside the string rather than sniffed out of it: a probe killed at
  // the deadline is the one outcome the health log cannot record, so the error
  // below has to be told, not left to guess (see `lastProbeText`).
  let lastTimedOut = false;
  while (Date.now() < deadline) {
    // Bounded by what is LEFT of the readiness budget, not by the budget: the
    // loop's `Date.now() < deadline` is only tested between probes, so a single
    // probe that never returns — a curl against a service that accepts and then
    // never answers — hangs the run forever, holding the single-instance lock,
    // with no HARD-ERROR and no teardown. config.ts rejects a NaN
    // readinessTimeoutMs for exactly this hang; a valid one must not reach it.
    //
    // This is the ONLY bound on a probe. Podman's `--health-timeout` is not
    // passed and would not help if it were: it lets the probe run to
    // completion and then labels the result as having exceeded the bound.
    const probe = await probeOnce(containerName, remainingMs(deadline));
    if (probe.ready) return;
    lastErr = probe.detail;
    lastTimedOut = probe.timedOut;
    // The recipe is untrusted consumer input and the branch's own code, so a
    // container whose entrypoint dies at startup is an EXPECTED failure. Report
    // it immediately with its log instead of polling a corpse for the full
    // timeout and then reporting a misleading "did not become ready".
    await throwIfDead(containerName, c, label);
    await sleep(READY_POLL_INTERVAL_MS);
  }
  // Read once, here, rather than on every failed poll: this sees the most
  // recent probes podman still holds, and a per-poll read would be a podman
  // call every 500ms for text nobody looks at until now.
  const entries = await readHealthLog(containerName);
  throw new ContainerBringupError(
    containerName,
    `${label}: container '${c.name}' (${c.image}) did not become ready ` +
      `within ${c.readinessTimeoutMs}ms (${describeReadiness(readiness)}; ` +
      `last probe: ${lastProbeText(entries, lastErr, lastTimedOut)})`,
    await logTail(containerName),
    // Sliced here rather than trusted to be short: podman keeps five by
    // default, but `--health-max-log-count` and containers.conf can raise it,
    // and the heading is a claim about what follows.
    formatHealthLog(entries.slice(-HEALTH_LOG_ENTRIES)),
  );
}

function describeReadiness(
  r: NonNullable<ResolvedStackContainer["readiness"]>,
): string {
  return `healthcheck ${JSON.stringify(r.command)}`;
}

// One probe, run by podman inside the container.
//
// `healthcheck run` exits 0 for a healthy probe, 1 for an unhealthy one, and
// 125 when podman could not run it at all — most often because the container
// is not running, which the `throwIfDead` beside this loop turns into a proper
// bringup failure rather than a readiness timeout. The 125 branch needs no
// special handling here for the same reason: it is not-ready either way, and
// the state question is asked by something that can answer it.
//
// The detail is the CLIENT's view, and for an ordinary failed probe it is only
// a fallback: `healthcheck run` prints `unhealthy` and nothing else, so what the
// probe actually said lives in the health log, which the timeout above reads.
//
// `timedOut` is the exception, and it is carried separately rather than left to
// be inferred from the detail string: a probe sandbar KILLED at the deadline
// records no health-log entry at all — the client died before podman could
// write one — so the health log's newest entry is some earlier, faster failure
// and nothing else in the error would ever say a probe stopped returning.
async function probeOnce(
  containerName: string,
  timeoutMs: number,
): Promise<{ ready: boolean; detail: string; timedOut: boolean }> {
  const r = await boundedPodman(
    ["healthcheck", "run", containerName],
    timeoutMs,
  );
  if (boundedOk(r)) return { ready: true, detail: "", timedOut: false };
  // A probe that never returns is NOT ready, and saying so is the whole point
  // of doing the timing here rather than through node's `timeout:`, which
  // would have killed the client, seen it exit 0, and reported the container
  // ready.
  return {
    ready: false,
    timedOut: r.timedOut,
    detail: r.timedOut
      ? `probe did not return within ${timeoutMs}ms and was killed`
      : r.errorMessage,
  };
}

// What podman says about a container right now.
//
// `unknown` means the question could not be answered, and is never evidence
// either way: read as death it would report a live container as a corpse,
// which is a HARD-ERROR from `assertIssueContainersAlive` and a bringup failure
// from `throwIfDead` — a slow host turned into a retry storm. It has two
// producers, and the second is the one worth naming: podman would not answer at
// all, OR it answered that the container EXISTS while `inspect` still could not
// say whether it is running. The latter is a real pairing (a 15s inspect
// timeout under load, a cheap `exists` answering 0), and it is what lets the
// readiness poll keep probing a container podman will not describe rather than
// declaring it dead on no evidence.
//
// `gone` is the state this used to lose (#36). A container that no longer
// EXISTS is the strongest evidence of death there is, but `inspect` reports it
// with the same exit 125 as a podman that is merely unwell, so a single inspect
// collapses it into `unknown` and the one check whose job is to catch it waves
// it through. It is not exotic: an operator's `podman rm` on a wedged stack, a
// `podman system prune`, an OOM kill under a removing restart policy, and —
// since #26 — `reapKilledStep` itself.
export type ContainerState = "running" | "stopped" | "gone" | "unknown";

// The seam these liveness reads are tested through. `containerState`'s whole
// job is to classify what podman answers, and the answers that matter most are
// the ones a real podman will not produce on demand — a timed-out inspect, a
// kill, an exit code `exists` does not document. Every other podman call in
// this module is exercised against a live podman in gate-stack-podman.test.ts;
// this one branch cannot be, and it is the branch whose misfire is a
// HARD-ERROR storm, so it gets an injectable probe instead (the same argument
// `realVerifyAdapter`'s `exec` and `checkWorktreeImageUids`' `UidProbe` make).
export type PodmanProbe = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<BoundedResult>;

// Does this container exist at all, in any state? Exit 1 and nothing else: 0
// means it is there, and a timeout, a kill, or an exit code `exists` does not
// document is podman being unreliable. The point is to shrink `unknown`
// honestly, not to let failure fall through to death.
async function containerGone(
  containerName: string,
  probe: PodmanProbe,
): Promise<boolean> {
  const e = await probe(
    ["container", "exists", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  return e.exitCode === 1 && !e.timedOut && !e.maxBufferExceeded;
}

// What `logTail` puts in the tail slot for a container that is not there.
// Skipping the read is not just an optimisation: `logs` against a removed
// container fails, and the "(logs unavailable)" that produces reads as "the log
// could not be retrieved" and sends the reader looking for a log that does not
// exist. Phrased to sit under `ContainerBringupError`'s "Container log tail:"
// header without contradicting it.
const GONE_LOG_NOTE = "(none — the container no longer exists)";

export async function containerState(
  containerName: string,
  probe: PodmanProbe = boundedPodman,
): Promise<ContainerState> {
  const r = await probe(
    ["inspect", "--format", "{{.State.Running}}", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  if (boundedOk(r)) return r.stdout.trim() === "true" ? "running" : "stopped";
  // Only when inspect RETURNED and said no. An inspect that timed out or was
  // killed is podman being unresponsive, not podman answering ambiguously —
  // `exists` would be asked to answer through the same wedged podman, and the
  // classification is `unknown` whatever it says. Skipping it there keeps this
  // function's worst case at one LOG_READ_TIMEOUT_MS rather than two, which
  // matters because `pollUntilReady` only tests its deadline BETWEEN probes:
  // doubling the worst case would double how far a readiness wait overshoots
  // its budget and halve how many polls a 60s budget buys.
  if (r.timedOut || r.maxBufferExceeded || r.exitCode === null) return "unknown";
  // Inspect exited non-zero on its own. That is 125 both for a container that
  // is GONE and for a podman that is unwell, so ask the question podman has a
  // purpose-built answer for rather than matching its stderr: the wording
  // differs per subcommand (`inspect` says "no such object", the exec family
  // says "no container with name or ID ... found"), so a string test would be
  // both fragile and version-bound. One extra call, only on a path where
  // inspect already failed — which in the ordinary case is never.
  return (await containerGone(containerName, probe)) ? "gone" : "unknown";
}

async function throwIfDead(
  containerName: string,
  c: ResolvedStackContainer,
  label: string,
): Promise<void> {
  const state = await containerState(containerName);
  // A flaked inspect is not evidence of death; let the deadline arbitrate.
  if (state === "running" || state === "unknown") return;
  throw new ContainerBringupError(
    containerName,
    state === "gone"
      ? `${label}: container '${c.name}' (${c.image}) no longer exists — ` +
        "something removed it during startup."
      : `${label}: container '${c.name}' (${c.image}) exited during startup.`,
    state === "gone" ? GONE_LOG_NOTE : await logTail(containerName),
  );
}

async function logTail(
  containerName: string,
  lines = CONTAINER_LOG_TAIL,
): Promise<string> {
  // MAX_BUFFER, not node's 1MB default: `--tail 40` bounds the LINE count, not
  // the byte count, and 40 lines of a JSON dump or a minified bundle overflows
  // it — losing the one diagnostic D9 exists to provide, precisely when the log
  // is biggest.
  const r = await boundedPodman(
    ["logs", "--tail", String(lines), containerName],
    LOG_READ_TIMEOUT_MS,
  );
  const text = stripAnsi(`${r.stdout}${r.stderr}`).trim();
  // A timed-out read keeps whatever it got — this is the diagnostic a hung
  // step's trace leans on entirely, so half of it beats none — but says that
  // it is partial, because a tail silently cut short reads as a log that just
  // stopped.
  if (r.timedOut) {
    const note =
      `(log read timed out after ${LOG_READ_TIMEOUT_MS}ms; this tail may be ` +
      "incomplete)";
    return text ? `${text}\n${note}` : note;
  }
  // "(logs unavailable)" reads as "the log could not be retrieved", which is
  // the wrong thing to hand an implementer agent reading a red gate's D9 block
  // about a container that is simply not there any more. The extra call is on a
  // path where `logs` has already failed, so it costs nothing in the ordinary
  // case. (`throwIfDead` and `assertIssueContainersAlive` do not reach this:
  // they already know the state and pass GONE_LOG_NOTE without reading.)
  if (!boundedOk(r)) {
    return (await containerGone(containerName, boundedPodman))
      ? GONE_LOG_NOTE
      : "(logs unavailable)";
  }
  return text || "(empty)";
}

// ---------------------------------------------------------------------------
// The gate run
// ---------------------------------------------------------------------------

type RunGateCtx = {
  readonly spec: ResolvedGateStack;
  readonly attemptContainers: readonly ResolvedStackContainer[];
  readonly issueContainers: readonly ResolvedStackContainer[];
  readonly attach: ContainerAttachment;
  readonly worktreePath: string;
  readonly nameOf: (c: ResolvedStackContainer) => string;
  readonly images: () => Promise<ImageMap>;
  // Mutable, owned by `startStack`: what the issue containers are running now.
  readonly running: { map: ImageMap };
  // #45; see `StackOptions`. Both false/absent for every gate inside a run.
  readonly allowDirtyWorktree: boolean;
  readonly onStepOutput?: ((chunk: string) => void) | undefined;
};

// The long-lived half of the stack, re-checked before every gate run.
//
// `lifecycle` was consulted only at bringup, which made the blame mapping hold
// for exactly as long as the first attempt. A database OOM-killed (or left dead
// by a host suspend, or removed out from under the run) at attempt 4 is still
// an INFRA failure, but every later step fails talking to it, so the gate reds,
// the implementer is asked to fix a service it never touched, the rest of the
// budget burns against a corpse and the run lands on NEEDS-HUMAN with an
// "environment" trace. That is D5 running backwards, and the fix is to ask.
// Throwing (rather than reddening) puts it back on the HARD-ERROR path, where
// the outer layer retries with a fresh stack.
//
// "Ask" has to mean a question podman can answer about a container that is not
// there (#36): a removed one used to be indistinguishable from a flaked inspect
// and was waved through, which is the exact failure above reached through the
// check meant to prevent it.
//
// Residual, stated rather than hidden: this runs ONCE per gate run (just after
// the per-branch image recreate, for the reason given at the call site). An
// issue container that dies after it and before step N still reds that
// gate against the branch — the misblame is narrowed from "every remaining
// attempt" to "exactly one", not eliminated. Re-checking between steps would
// cost a podman call per step per gate run to shave one attempt off a failure
// that is already rare, and would still leave a window inside the step itself.
async function assertIssueContainersAlive(ctx: RunGateCtx): Promise<void> {
  for (const c of ctx.issueContainers) {
    const containerName = ctx.nameOf(c);
    const state = await containerState(containerName);
    if (state === "running" || state === "unknown") continue;
    // The two death states get different prose because they imply different
    // next steps: a stopped container is still there to be inspected and its
    // log read, whereas a removed one cannot be looked at at all and the
    // operator's question is who removed it. Reporting a removal as "no longer
    // running" sends them to `podman logs` for a container that answers "no
    // container with name or ID ... found".
    const what =
      state === "gone"
        ? "no longer exists — someone or something removed it"
        : "is no longer running";
    throw new ContainerBringupError(
      containerName,
      // The image it is actually RUNNING, which since #37 is not always the one
      // config names — sending the operator to inspect the declared tag when a
      // per-branch variant is what died is a wrong answer to the first question
      // they will ask.
      `gate stack: issue-lifecycle container '${c.name}' ` +
        `(${imageFor(c, ctx.running.map)}) ${what}. ` +
        "It came up once for this issue and every attempt since has depended " +
        "on it, so this is an infrastructure failure and not a verdict about " +
        "the branch.",
      state === "gone" ? GONE_LOG_NOTE : await logTail(containerName),
    );
  }
}

async function runStackGate(ctx: RunGateCtx): Promise<GateResult> {
  // The verdict is about a commit, so the tree had better BE the commit. This
  // also covers gate-2 in the merger worktree, where the resolve agent can
  // leave edits behind; the inner loop short-circuits earlier (the state
  // machine re-prompts the implementer to commit) and never reaches here dirty.
  //
  // Suspended for the standalone `sandbar gate` alone (#45), where there is no
  // merger and no commit and the operator means the tree in front of them. The
  // read itself is skipped rather than merely ignored: a tree handed to
  // `sandbar gate` need not be a git worktree at all, and `git status` throws
  // rather than shrugging when it is not.
  const dirty = ctx.allowDirtyWorktree
    ? []
    : await dirtyWorktreePaths(ctx.worktreePath);
  if (dirty.length > 0) {
    return {
      ok: false,
      stdout: "",
      stderr:
        "Refusing to gate: the worktree has uncommitted changes, so a verdict " +
        "about it would not be a verdict about any commit. Commit or discard:\n" +
        dirty.map((p) => `  ${p}`).join("\n"),
      exitCode: 1,
      failedStep: "worktree-clean",
      containerLogs: "",
    };
  }

  // Which images this commit should be gated with (#37). After the cheap
  // checks above — a dirty tree gets no verdict at all, so there is no reason
  // to pay a build for it — and before any container is created.
  //
  // A build that fails is a RED GATE, not an infrastructure failure, and this
  // is the same argument D5 makes about `attempt` containers: the image is a
  // function of the branch, so a lockfile that does not install is the branch's
  // to fix. Routed to HARD-ERROR it would buy two fresh-stack retries that
  // reproduce it exactly and then park the issue with a trace blaming the
  // environment for a dependency the agent chose.
  let images: ImageMap;
  try {
    images = await ctx.images();
  } catch (err) {
    if (err instanceof ImageBuildError) {
      return {
        ok: false,
        stdout: "",
        stderr:
          `Refusing to gate: image '${err.tag}' could not be built from this ` +
          "worktree. It declares `rebuildOn` paths that this branch changed, " +
          "so the gate needs an image built from the branch's own " +
          "dependencies and this branch does not produce one.\n\n" +
          err.message,
        exitCode: 1,
        failedStep: `image:${err.tag}`,
        // Deliberately empty. D9 collects container logs because the diagnosis
        // of a failing step is often in a container the step never touched;
        // here nothing has run yet and the build's own output is the whole
        // diagnosis, already above.
        containerLogs: "",
      };
    }
    throw err;
  }

  // The `issue` containers are normally NOT recreated — that is the whole point
  // of the lifecycle — but one whose image the branch just changed is running
  // the wrong bytes, which is the same staleness the recreate-every-run rule
  // below exists to prevent one level down. Its bringup failure is a red rather
  // than a HARD-ERROR, and that is a deliberate exception to D5: D5 maps
  // `issue` to infra because such a container depends only on image + env, and
  // an image the branch authored is precisely where that stops being true.
  const staleIssueContainers = ctx.issueContainers.filter(
    (c) => imageFor(c, images) !== imageFor(c, ctx.running.map),
  );
  if (staleIssueContainers.length > 0) {
    try {
      await bringUpContainers(withImages(staleIssueContainers, images), {
        attach: ctx.attach,
        label: GATE_LABEL,
        worktreePath: ctx.worktreePath,
        nameOf: ctx.nameOf,
      });
    } catch (err) {
      if (err instanceof ContainerBringupError) {
        return withContainerLogs(
          {
            ok: false,
            stdout: "",
            stderr: err.message,
            exitCode: 1,
            failedStep: `container:${err.containerName}`,
            containerLogs: "",
          },
          ctx,
        );
      }
      throw err;
    }
    // Only after they are actually up. A failed recreate leaves the previous
    // map in place so the NEXT gate run recreates them again rather than
    // recording a state the containers never reached — which is also what keeps
    // `assertIssueContainersAlive` honest below: `bringUp` removes before it
    // creates, so a recreate that died left the container GONE, and a run that
    // reported that as an infrastructure death would be blaming the environment
    // for a container sandbar removed on the branch's behalf.
    ctx.running.map = images;
  }

  // Deliberately OUTSIDE the try blocks that convert bringup failures to a gate
  // red: a dead issue container must reach the caller as a throw.
  //
  // After the recreate above, not before it. Ordered the other way, a container
  // the previous gate run removed and failed to recreate reads as "it came up
  // once and something killed it" — an infra HARD-ERROR — when the truth is
  // that the branch's own image would not start and this run was about to try
  // again. What it still catches is unchanged: a container nothing here touched
  // that died on its own between gate runs.
  await assertIssueContainersAlive(ctx);

  // Recreated every gate run: they mount the worktree and run the branch's
  // code, so reusing one would gate an earlier attempt's process against a
  // later attempt's source.
  try {
    await bringUpContainers(withImages(ctx.attemptContainers, images), {
      attach: ctx.attach,
      label: GATE_LABEL,
      worktreePath: ctx.worktreePath,
      nameOf: ctx.nameOf,
    });
  } catch (err) {
    if (err instanceof ContainerBringupError) {
      return withContainerLogs(
        {
          ok: false,
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          failedStep: `container:${err.containerName}`,
          containerLogs: "",
        },
        ctx,
      );
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  for (const step of ctx.spec.steps) {
    const container = ctx.spec.containers.find((c) => c.name === step.in);
    // resolveGateStack proved this at config time; a miss here is a bug.
    if (container === undefined) {
      throw new SandbarError(
        `gate stack: step '${step.name}' targets unknown container '${step.in}'.`,
      );
    }
    const containerName = ctx.nameOf(container);
    const banner = `\n== ${step.name} (${step.in})\n`;
    // The banner goes to the live view too, and before the step rather than
    // with its first byte: a step that produces nothing for minutes is exactly
    // the one whose name a watcher needs (#45).
    ctx.onStepOutput?.(banner);
    const r = await boundedPodman(
      stepExecArgs(containerName, step.command),
      step.timeoutMs,
      ctx.onStepOutput,
    );
    if (boundedOk(r)) {
      stdout += banner + stripAnsi(r.stdout);
      stderr += stripAnsi(r.stderr);
      continue;
    }

    // Named, because otherwise the two kills below are indistinguishable from
    // an ordinary red: node reports a maxBuffer kill with a STRING code, so it
    // would land as a plain `exitCode: 1` with silently truncated output — a
    // verbose but PASSING suite reading as a real, unexplained failure that
    // reproduces identically every attempt until the budget dies — and a
    // timeout arrives with no output and no exit code at all.
    const note = r.timedOut
      ? `\n\n[sandbar] step '${step.name}' was still running after ` +
        `${step.timeoutMs}ms and was killed (this step's \`timeoutMs\`, or ` +
        "sandbar's default for one). A step that exceeds its bound is a red " +
        "gate, not an infrastructure failure: the usual cause is the branch's " +
        "own code — a test awaiting a promise that never resolves, a suite " +
        "whose reporter never exits. The step's own output above is only what " +
        "it had flushed before the kill and is often empty, so the diagnosis " +
        "is usually in the container logs. Raise `timeoutMs` for this step if " +
        "the work is genuinely this slow.\n"
      : r.maxBufferExceeded
        ? `\n\n[sandbar] step '${step.name}' produced more than ` +
          `${MAX_BUFFER} bytes of output and was killed; the output above is ` +
          "truncated and the exit code is unknown. This is an output-volume " +
          "failure, not necessarily a test failure — quieten the step's " +
          "reporter.\n"
        : "";

    // Stop at the first red. Every later step tends to read what an earlier
    // one built, so running them would bury the real failure under derived
    // ones: a test suite that fails because the build step before it never
    // produced anything reports N failures that are all one failure.
    //
    // The container logs are collected BEFORE the reap below — removing the
    // container first would throw away the one diagnostic a hang leaves.
    const red = await withContainerLogs(
      {
        ok: false,
        stdout: stdout + banner + stripAnsi(r.stdout) + note,
        stderr: stderr + stripAnsi(r.stderr),
        // 124 is GNU `timeout`'s convention, and the alternative is worse than
        // arbitrary: a killed process has no exit code, so the honest-looking
        // `1` is indistinguishable from a suite that ran and failed once.
        exitCode: r.timedOut ? 124 : (r.exitCode ?? 1),
        failedStep: step.name,
        containerLogs: "",
      },
      ctx,
    );
    // Both kills leave the work running inside the container — node SIGTERMs
    // the client for a maxBuffer overflow exactly as the timer does, and podman
    // exits 0 either way — so both reap. An ordinary non-zero exit does not:
    // the process is already gone.
    if (r.timedOut || r.maxBufferExceeded) {
      await reapKilledStep(container, containerName, ctx, red.failedStep ?? "");
    }
    return red;
  }
  return {
    ok: true,
    stdout,
    stderr,
    exitCode: 0,
    failedStep: null,
    containerLogs: "",
  };
}

// Kill the work a killed step left running inside its container (#26).
//
// The `podman exec` client is dead by the time this runs, and that is all the
// kill accomplished: the process it started keeps running in the container
// (pinned in gate-stack-podman.test.ts, for both the timer's SIGKILL and the
// SIGTERM node sends on a maxBuffer overflow). Leaving it there means a wedged
// suite burning CPU beside the next attempt's gate and, for anything stateful,
// skewing what that gate measures — the failure the timeout was supposed to
// END, made quieter rather than fixed.
//
// The container is the only handle that is total. Killing the process directly
// would mean either a `kill` binary in an image sandbar does not control, or
// matching argv against `podman top` output and walking its PPID column — both
// of which fail exactly where a hang is most likely, on a test runner that has
// spawned children of its own.
async function reapKilledStep(
  container: ResolvedStackContainer,
  containerName: string,
  ctx: RunGateCtx,
  stepName: string,
): Promise<void> {
  const removed = await boundedPodman(
    ["rm", "-f", "-t", "0", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  if (!boundedOk(removed)) {
    // Not fatal, and not silent. The verdict is already decided, and the next
    // gate run force-removes this container by name before recreating it — a
    // remove that is itself bounded, so this tolerance cannot become a hang —
    // so throwing here would trade a red gate for a HARD-ERROR over a leftover
    // that clears itself. But a survivor burns CPU until then, so say so.
    // For an `issue` container it does not even reach the next run: the
    // recreate below force-removes this name before running, so a remove that
    // failed here fails there too and takes the run down with a bringup error
    // rather than silently gating against a survivor.
    const why = removed.timedOut
      ? `\`${RUNTIME} rm\` timed out`
      : removed.stderr.trim() || removed.errorMessage;
    console.error(
      `gate stack: could not remove container '${containerName}' after its ` +
        "step timed out, so the timed-out work may still be running inside " +
        `it: ${why}`,
    );
  }
  // An `attempt` container is recreated by the next gate run anyway. An
  // `issue` one is not, so it is put back here.
  //
  // Be precise about what that prevents. Until #36 the answer was "the gate
  // going red against the branch": `assertIssueContainersAlive` could not see a
  // REMOVED container at all, so every later step targeting it exited 125 and
  // reddened the gate, D5's blame mapping running backwards for a container
  // sandbar itself removed. That check now catches it — which makes the
  // recreate here an optimisation rather than the only thing standing between
  // this reap and a misattributed verdict, but an optimisation worth keeping:
  // the alternative is throwing away a working stack and the rest of the
  // issue's attempts on a HARD-ERROR, for a container we know exactly how to
  // put back.
  //
  // The cost is more than the re-run of `postReadyCommands`: everything the
  // container accumulated beyond its declared setup goes with it — a schema an
  // earlier gate step migrated, rows an earlier attempt wrote, fixtures
  // uploaded into it. A held `issue` container is the only home for per-issue
  // setup, so consumers are invited to keep exactly that state there. Losing it
  // is still better than the alternatives: leaving a runaway inside it for the
  // rest of the issue, or reporting a red the branch cannot act on.
  if (container.lifecycle !== "issue") return;
  try {
    // `ctx.running.map`, not the declared spec and not a fresh `ctx.images()`.
    // The declared spec is #37 reintroduced through the one bringup that
    // neither precedes nor follows a `running.map` update: a container recreated
    // from the base image while the map still says it is on the branch's
    // variant is never seen as stale again, so every remaining attempt gates
    // against the source branch's dependencies — silently, green included. And
    // it must be the map as it STANDS: this is a restore of what was running,
    // not a new resolution, and re-resolving mid-red would pay a build for a
    // gate whose verdict is already decided.
    await bringUpContainers(withImages([container], ctx.running.map), {
      attach: ctx.attach,
      label: GATE_LABEL,
      worktreePath: ctx.worktreePath,
      nameOf: ctx.nameOf,
    });
  } catch (err) {
    // Deliberately not swallowed, even though it costs the red gate we were
    // about to return: a stack whose issue container will not come back up IS
    // an infrastructure failure, and HARD-ERROR retries it on a fresh stack.
    //
    // This is the one exception to "a step timeout is always a gate red", and
    // it is stated rather than hidden: on this path the step name, the bound
    // and the D9 container logs are all discarded in favour of the bringup
    // error, so the line below is what connects the two for whoever reads the
    // run's output.
    console.error(
      `gate stack: step '${stepName}' was killed in issue-lifecycle container ` +
        `'${container.name}', and recreating that container failed. The gate's ` +
        "verdict is being discarded in favour of the bringup failure below.",
    );
    throw err;
  }
}

// Collect a labelled log tail for every stack container onto a RED gate (#24 D9).
//
// When the browser step fails because the backend is 500ing, the step's own
// output ("expected 200, got 500") is undiagnosable and the answer is in a
// container the step never touched. It lands in its own `containerLogs` field
// rather than on stderr, so the cascade collapse never reads it as test output
// — see the field's comment in gate.ts.
async function withContainerLogs(
  result: GateResult,
  ctx: RunGateCtx,
): Promise<GateResult> {
  const sections: string[] = [];
  for (const c of ctx.spec.containers) {
    const name = ctx.nameOf(c);
    sections.push(
      `\n--- container ${c.name} (last ${CONTAINER_LOG_TAIL} lines) ---\n` +
        (await logTail(name)),
    );
  }
  return { ...result, containerLogs: sections.join("\n") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
