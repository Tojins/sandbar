// The sandbox stack (#44): the application, running beside the AGENT.
//
// An implementer that cannot run the application before the gate does writes a
// test it has never watched fail and a fix it has never watched pass. Until now
// the only way to give it one was to rebuild the whole stack as PROCESSES
// inside the sandbox image — a consumer of this package really did apt-install
// mariadb, download a libc-matched mailhog binary because the official image is
// musl, hand-write a my.cnf to match the gate container's `--sql-mode`, and
// then 163 lines of `pgrep`/`mysqladmin ping`/`curl -sf`/`setsid`/`pkill` to
// supervise it. That is a FOURTH environment (prod, dev, gate, sandbox) whose
// only defence against drift is being built `FROM` the gate's images, and every
// bug in it is a bug podman does not have.
//
// The description of what it takes to run the app already exists: it is
// `config.gateStack.containers`. So a container marks itself `inSandbox: true`
// and sandbar runs a second copy of it next to the agent. One description, two
// stacks.
//
// ---------------------------------------------------------------------------
// The topology, and why it is not a pod
// ---------------------------------------------------------------------------
// The siblings join the AGENT CONTAINER'S network namespace with
// `--network container:<anchor>`. That is the docker pattern gate-stack.ts
// refuses, and reading that refusal is how you see why this is not a
// contradiction: every objection there is to the anchor being a FOREIGN
// container — it owns the namespace-wide flags, and removing it destroys the
// namespace, so it can never be a per-attempt container. Here the anchor IS the
// per-issue sandbox: created first, outliving every sibling, never recreated.
//
// A pod is not merely unattractive here, it is unavailable, and the chain of
// podman facts is short:
//
//   1. `--pod` and `--userns=keep-id` cannot be combined — podman refuses.
//   2. Inside a pod, `--user 1000:1000` maps to a SUBUID, so a member that
//      writes to the bind-mounted worktree gets EACCES; only container root
//      maps back to the invoking user. That is the gate's D3 rule, and it is
//      why the gate's images run as root.
//   3. `podman pod create --userns=keep-id` exists and is a trap: every member
//      then runs as uid 1000, so `mariadb` dies within a second on its own
//      datadir, and an explicit `--user 0` inside such a pod maps to subuid
//      100000 and fails on the worktree from the other side. Dead both ways —
//      it cannot host the gate's own container definitions, which is the point.
//   4. `claude --print --dangerously-skip-permissions` REFUSES to run as root,
//      and sandbar passes that flag on every agent invocation.
//
// So "put the sandbox in a pod" is "make the agent run as root and bet the
// whole loop on an undocumented `IS_SANDBOX=1` escape hatch". The chain costs
// ONE mechanical item instead — teardown must remove joiners BEFORE the anchor
// — and nothing about the agent's own environment moves.
//
// It cost two until #43. A `tcp` readiness was probed from the host through a
// published port, and podman refuses `-p` on a `--network container:` joiner,
// so the subset's ports had to be computed and handed to the anchor before it
// was created. That whole half went with the kind: the probe is now
// `podman healthcheck run` INSIDE the container, so the chain publishes exactly
// what the gate's pod does, which is nothing.
//
// The gate's other anchor-owned flag was never one of them either, and the
// symmetry is close enough to be worth writing down: the pod carries `--dns`
// because #18 puts it on a `--disable-dns` network, while the agent container
// sits on podman's default network with its resolver intact — it has always had
// to reach the API through it. Nothing here changes that, and the joiners
// inherit the anchor's resolv.conf. Give the sandbox a `--disable-dns` network
// one day and the `--dns` would have to go on the anchor, since podman refuses
// one on a `--network container:` joiner.
//
// The isolation the issue asks for comes from this being a DIFFERENT namespace
// from the gate's pod, not from the absence of a runtime inside the sandbox.
// The agent must not be able to reach the stack its verdict is formed in, and
// that is now a structural property rather than a matter of which socket
// happened to be mounted.
//
// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------
// Up: the issue worktree, then `hooks.host.onWorktreeReady` (a consumer's
// `npm ci` — the siblings may need `node_modules` to exist before they boot),
// then the ANCHOR, then the siblings, then `hooks.*.onSandboxReady`. That last
// position is the one worth stating: the siblings are up BEFORE the
// sandbox-ready hooks, because those hooks are exactly where a consumer runs
// the migration or the seed that wants the database. Ordered the other way,
// the one hook that most wants the stack is the one hook that cannot see it.
// `createSandbox`'s `beforeSandboxReady` is what buys it.
//
// Down: JOINERS BEFORE THE ANCHOR, since removing the anchor destroys the
// namespace under them — and podman refuses to do it at all while one is
// attached, so getting this backwards leaks the whole chain rather than half.
//
// Siblings are created once per SANDBOX and disposed with it. The gate's
// "recreate `attempt` containers every gate run" rule does not carry over: it
// exists so a verdict is never formed against stale code, and this stack forms
// no verdict, while recreating would throw away whatever the agent had
// accumulated. A HARD-ERROR retry gets a whole fresh set, exactly as it gets a
// fresh agent container.
//
// ---------------------------------------------------------------------------
// Whose failure a failed bringup is
// ---------------------------------------------------------------------------
// D5's question, rotated onto a stack that has no verdict to redden:
//
//   `issue` lifecycle (a database, a mail catcher — depends only on image and
//   env): throws. The runner wraps it as HARD-ERROR and the issue retries with
//   a fresh sandbox. Unchanged reasoning.
//
//   `attempt` lifecycle (mounts the worktree, runs branch code): the sandbox
//   comes up DEGRADED and the agent is told, in its prompt, with that
//   container's log tail. The agent is the one entity in the system that can
//   fix its own app's bootstrap; spending two fresh-sandbox retries to
//   reproduce an error it could have read is exactly what D5 was written to
//   stop. The loop gains no event and no terminal from this — only the prompt
//   gains a slot.
//
// Which is also why the attempt containers are brought up ONE AT A TIME while
// the issue ones go up as a group: `bringUpContainers` abandons the rest on the
// first failure, and "degraded" has to mean the other siblings still came up.
// The cost is serialized readiness waits across the attempt subset, which is
// bounded by how many of them a consumer declares (the motivating one declares
// exactly one).
//
// ---------------------------------------------------------------------------
// Logs, and the one place this is worse than the script it deletes
// ---------------------------------------------------------------------------
// `sandbox-stack-up.sh` gave its agent log files under `~/.sandbox` and
// `pkill -f` restart. A netns sibling with no runtime inside the sandbox gives
// neither for free, and logs are not negotiable — an agent debugging a 500 with
// no log is a regression against the script. So sandbar follows each sibling's
// `podman logs -f` into a file on the host and bind-mounts that directory
// READ-ONLY into the agent container at `/sandbar/logs/<name>.log`. Side
// benefit: those files are an offline artefact in the run log tree.
//
// EVERY sibling is followed, including one that did not come up, and the
// degraded case is the one that needs it rather than the exception to it: the
// commonest shape of a failed bringup is a container that started and then
// missed its readiness probe or a postReadyCommand, so it keeps running and
// keeps logging for the rest of the issue — exactly when the agent has been
// told, in the same prompt, that its log says why. A file frozen at the bringup
// tail makes that sentence false. A container that never started at all costs
// nothing here: `podman logs -f` fails, its complaint lands in the same file,
// and the follower notes its exit. The bringup error is written in ahead of it
// either way, because the path is quoted to an agent that will follow it and an
// ENOENT reads as sandbar having lost the log.
//
// The statuses this returns are a snapshot of BRINGUP, not a live readout, and
// nothing re-reads them: a sibling OOM-killed at attempt 4 still renders as
// running in every later prompt. The gate re-checks its `issue` containers
// before every gate run because a corpse there produces a wrong VERDICT (D5);
// here the cost is an agent chasing a connection refused, so the prompt is told
// what the list is instead — a per-attempt liveness sweep would be the fix if
// that ever proves worse than it sounds.
//
// RESTART IS DELIBERATELY NOT HERE, and it is stated as a limit rather than
// assumed away: a sibling that reads configuration at BOOT is stale for the
// rest of the issue once the agent edits it, and nothing in this design
// restarts it. Mounted interpreted code under a server, and any service the
// agent only ever talks to, are unaffected — which covers the motivating
// consumer, but that is a claim about one consumer. The follow-on, if it bites,
// is a control channel: a shim in the sandbox over a bind-mounted unix socket
// offering `restart <name>` / `logs <name>`, with sandbar making the podman
// call host-side so the agent still never gets a runtime. Its own issue.
//
// The follower is a real long-lived `spawn`, and it is the only one sandbar
// still holds now that #43 retired the gate's — so the signal caveat that used
// to live in gate-stack.ts's header lives here instead. `stop` kills it and
// runs on every path out of this stack, including the cleanup registry's, so
// SIGINT and SIGTERM are covered; SIGKILL, an untrapped SIGHUP and a teardown
// that throws before it reaches the followers can each orphan one, blocked in
// read on a quiet container. It holds no lock and no podman resource, so what
// leaks is a stray process rather than anything that blocks the next run.
//
// The file is UNCAPPED, and the two consequences are worth stating rather than
// discovering. A service that logs every query writes for as long as the issue
// lasts, into the state directory — which is disposable by construction, so the
// cost is disk rather than correctness, and the alternative is worse: a rotated
// or truncated file removes exactly the tail the prompt is telling the agent to
// read. And the path is per ISSUE, not per sandbox, so a HARD-ERROR retry's
// containers append to the same file; every write here is therefore an append,
// including the placeholder for a container that never came up, or the retry
// would silently take the previous sandbox's log with it.
//
// ---------------------------------------------------------------------------
// Images, and the confusion mode that buys
// ---------------------------------------------------------------------------
// Siblings run the image their config NAMES, resolved once — never a
// `rebuildOn` variant. #37 does not extend here: the gate re-resolves before
// every gate run because an image that bakes a lockfile is a function of the
// branch and a stale one is a WRONG VERDICT; a sibling is part of a workspace
// rather than of a verdict, so a stale layer costs the agent a command
// (`npm ci` into its own container) rather than an answer. Note where the line
// now falls: #46 makes the AGENT container's own image a function of the
// branch, resolved once per sandbox for this same reason (a workspace wants a
// fresh-enough image, not a per-attempt one) — its siblings are still not.
//
// The confusion mode that accepts, stated because it is real: the agent's suite
// may pass against baked dependencies the branch has since changed while the
// gate, which rebuilds, reds. THE GATE IS AUTHORITATIVE, and the prompt says so.
//
// ---------------------------------------------------------------------------
// Two stacks, one worktree
// ---------------------------------------------------------------------------
// The two stacks are separate namespaces, so nothing collides on ports — but
// they bind-mount the SAME worktree, and the sandbox's app keeps writing while
// gate-1 forms a verdict. Not paused and not stopped: pausing is a fourth state
// to reason about for a hazard the consumer already handles for the gate, and a
// paused database holding live connections buys a new class of flake. So
// CLAUDE.md's D1 corollary — a gate step must write only into gitignored paths,
// or its own exhaust is reported as uncommitted work every attempt until the
// budget dies — now extends to sandbox siblings, which write continuously
// rather than only during a step. A compiled-cache race between two identical
// applications over one directory is real and is the consumer's to resolve with
// per-environment cache paths.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { onCleanup } from "./cleanup.js";
import type { ResolvedGateStack, ResolvedStackContainer } from "./config.js";
import { SandbarError } from "./errors.js";
import {
  type BringUpCtx,
  CONTAINER_RM_ARGS,
  type ContainerAttachment,
  CONTROL_TIMEOUT_MS,
  ContainerBringupError,
  boundedOk,
  boundedPodman,
  bringUpContainers,
  containerState,
} from "./gate-stack.js";
import { type RunScope, sandboxContainerNameFor } from "./naming.js";
import { RUNTIME } from "./runtime.js";

// What this stack is called in the messages `bringUpContainers` raises about
// it. The whole reason `BringUpCtx` carries a label: the shared bringup is the
// gate's code, and its errors are the string D3 hands the agent and the
// operator — see that field's comment for what a `gate stack:` prefix does to
// both of them.
const SANDBOX_LABEL = "sandbox stack";

// Where the followers' files appear INSIDE the agent container. A fixed path,
// because it is quoted in the implementer's prompt and an agent should be able
// to `tail -f` it without being told a new location every run.
export const SANDBOX_LOG_MOUNT = "/sandbar/logs";

export function sandboxLogPathFor(containerName: string): string {
  return `${SANDBOX_LOG_MOUNT}/${containerName}.log`;
}

// The subset of the gate stack that also runs beside the agent. Empty for every
// consumer that declares no `inSandbox` container, and an empty subset means no
// sandbox stack at all — no extra containers, no log mount, no prompt slot.
// That is what makes #44 opt-in by construction.
export function sandboxContainers(
  spec: ResolvedGateStack,
): readonly ResolvedStackContainer[] {
  return spec.containers.filter((c) => c.inSandbox);
}

// What the implementer's prompt is rendered from (#44 D8). One entry per
// declared sandbox container, whether or not it came up — a container the agent
// is not told about is one it will rebuild by hand, which is the failure this
// whole feature exists to end.
export type SandboxContainerStatus = {
  readonly name: string;
  readonly image: string;
  readonly lifecycle: "issue" | "attempt";
  // No address, and that is #43's doing rather than an omission: readiness is
  // now a probe podman runs INSIDE the container, so no port number is written
  // down anywhere in the config for sandbar to read. The siblings share the
  // agent's loopback, which the prompt says once; which port each service
  // listens on is the consumer's own documentation to give, and inventing one
  // would be worse than saying nothing.
  // Path INSIDE the agent container.
  readonly logPath: string;
  readonly up: boolean;
  // Why it is not up: the bringup error, which already carries the container's
  // log tail. Null when `up`.
  readonly failure: string | null;
};

export type SandboxStack = {
  readonly statuses: readonly SandboxContainerStatus[];
  readonly stop: () => Promise<void>;
};

export type SandboxStackOptions = {
  // The issue this sandbox belongs to; the name segment that keeps two issues'
  // siblings apart.
  readonly issueId: string;
  readonly scope: RunScope;
  readonly spec: ResolvedGateStack;
  // The issue worktree — the same tree the agent edits and the gate mounts.
  readonly worktreePath: string;
  // The agent container. Every sibling joins its network namespace, so it must
  // already be running.
  readonly anchorContainerName: string;
  // Host directory the followers write into. Must be the same directory the
  // anchor has mounted at SANDBOX_LOG_MOUNT — created by `prepareSandboxLogDir`
  // BEFORE the anchor, because a bind-mount source is read at container start.
  readonly logDir: string;
};

// Everything this module does to podman, behind one seam — because what is
// worth testing here is the DECISIONS above it, and every one of them is a
// decision about a failure a real podman will not produce on demand. D3's blame
// mapping is the sharpest: an `issue` sibling that will not start is
// infrastructure and throws, an `attempt` one is the branch's own bootstrap and
// comes up degraded with its log tail in the agent's prompt. Get that backwards
// and the symptom is two fresh-sandbox retries reproducing an error the agent
// could have read — a failure invisible in a green suite. The same argument
// `PodmanProbe` and `UidProbe` make; the real implementations are below and are
// what production uses, the argv they build is table-tested next door
// (`containerRunArgs` with a `netns` attachment), and the whole chain is
// exercised against a real podman in sandbox-stack-podman.test.ts.
export type SandboxStackDeps = {
  readonly bringUp: (
    containers: readonly ResolvedStackContainer[],
    ctx: BringUpCtx,
  ) => Promise<void>;
  // Null when the container is gone — removed, or never created at all. Any
  // other value is the operator-facing description of what leaked, so the
  // judgment of "leaked" versus "was never there" lives in the real
  // implementation rather than in `stop`.
  readonly remove: (containerName: string) => Promise<string | null>;
  readonly follow: (containerName: string, filePath: string) => LogFollower;
};

export const realSandboxStackDeps: SandboxStackDeps = {
  bringUp: bringUpContainers,
  remove: removeSibling,
  follow: startLogFollower,
};

// Create the log directory before the anchor is created. Separate from
// `startSandboxStack` for a sequencing reason rather than a stylistic one: the
// mount source has to exist when the AGENT container starts, and that is before
// this module gets to do anything.
export async function prepareSandboxLogDir(logDir: string): Promise<void> {
  await mkdir(logDir, { recursive: true });
}

export async function startSandboxStack(
  opts: SandboxStackOptions,
  deps: SandboxStackDeps = realSandboxStackDeps,
): Promise<SandboxStack> {
  const containers = sandboxContainers(opts.spec);
  const nameOf = (c: ResolvedStackContainer): string =>
    sandboxContainerNameFor(opts.scope, opts.issueId, c.name);

  const followers: LogFollower[] = [];
  const created: string[] = [];
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const f of followers) f.stop();
    // Reverse creation order, and JOINERS BEFORE THE ANCHOR is the invariant
    // that matters — the anchor is removed by `sandbox.close()`, which the
    // inner loop calls after this, and by the cleanup registry, which pops in
    // LIFO order and so reaches this stack before the agent-sandbox teardown
    // registered when the anchor was created. `podman rm` on a container others
    // are attached to is refused outright, so getting that backwards leaks the
    // whole chain rather than half of it.
    //
    // A genuine failure is reported, never swallowed: what leaks here is a
    // running container holding a worktree mount, and the only backstop is the
    // next cycle's scoped sweep — which on the last cycle, or on a halt, never
    // runs. "Genuine" is `removeSibling`'s judgment, not this loop's, and it is
    // the difference between a report worth reading and one an operator learns
    // to skip: two ordinary paths arrive here with the container already gone.
    const failures: string[] = [];
    const leaked: string[] = [];
    for (const name of [...created].reverse()) {
      const failure = await deps.remove(name);
      if (failure === null) continue;
      failures.push(failure);
      leaked.push(name);
    }
    if (failures.length > 0) {
      throw new SandbarError(
        `sandbox stack: teardown of the sandbox siblings for issue ` +
          `${opts.issueId} failed, leaking podman resources:\n` +
          `${failures.join("\n")}\n` +
          `Clean up with: ${RUNTIME} rm -f -t 0 ${leaked.join(" ")}`,
      );
    }
  };
  // Registered before the first container exists, so a signal anywhere in the
  // bringup below still sweeps what was created. ONE entry for the whole stack
  // — that registry never forgets an action, so one per container would grow
  // without limit across a run.
  onCleanup(stop);

  const attach: ContainerAttachment = {
    kind: "netns",
    anchorContainerName: opts.anchorContainerName,
  };
  const ctx: BringUpCtx = {
    attach,
    label: SANDBOX_LABEL,
    worktreePath: opts.worktreePath,
    nameOf,
  };

  const record = (
    c: ResolvedStackContainer,
    failure: string | null,
  ): SandboxContainerStatus => ({
    name: c.name,
    image: c.image,
    lifecycle: c.lifecycle,
    logPath: sandboxLogPathFor(c.name),
    up: failure === null,
    failure,
  });

  // A container that reached `podman run` has a name to remove even if it never
  // became ready, so teardown has to know about it before readiness is decided.
  const claim = (group: readonly ResolvedStackContainer[]): void => {
    for (const c of group) if (!created.includes(nameOf(c))) created.push(nameOf(c));
  };

  // Why a sibling is not up, by container name. Collected rather than pushed
  // into `statuses` as the bringups go, so the list the agent reads is in the
  // consumer's DECLARATION order: the two lifecycle groups are brought up
  // separately for the reason above, and ordering the prompt by that internal
  // detail would show a stack the consumer never wrote.
  const failed = new Map<string, string>();

  try {
    const issueContainers = containers.filter((c) => c.lifecycle === "issue");
    if (issueContainers.length > 0) {
      claim(issueContainers);
      // As a group, and a throw here is infra: these depend only on image and
      // env, so a fresh sandbox is exactly the right response.
      await deps.bringUp(issueContainers, ctx);
    }

    // One at a time, so one broken app server does not take the database's
    // sibling down with it — see the header.
    for (const c of containers.filter((c) => c.lifecycle === "attempt")) {
      claim([c]);
      try {
        await deps.bringUp([c], ctx);
      } catch (err) {
        if (!(err instanceof ContainerBringupError)) throw err;
        failed.set(c.name, err.message);
      }
    }

    for (const c of containers) {
      const failure = failed.get(c.name);
      if (failure !== undefined) {
        // The path is quoted in the agent's prompt either way, so it has to
        // resolve to something that explains itself rather than to ENOENT. The
        // prompt carries the same text; this is the copy an agent finds by
        // following the path it was given.
        //
        // Appended, like the follower's own writes: the log directory is per
        // issue, so on a HARD-ERROR retry this file may already hold the
        // previous sandbox's log, and truncating it would throw away the only
        // record of what the run did before it restarted.
        await appendFile(
          join(opts.logDir, `${c.name}.log`),
          `[sandbar] container '${c.name}' did not come up.\n\n${failure}\n`,
          "utf8",
        ).catch(() => {});
      }
      // Followed whether or not it came up, and the degraded case is the one
      // that needs it: the commonest shape there is a container that STARTED
      // and then missed its readiness or a postReadyCommand, so it is running
      // and logging for the rest of the issue while the prompt tells the agent
      // its log says why. Frozen at the bringup tail, that sentence is false.
      // For a container that never started, the follower writes podman's own
      // complaint into the same file and notes its exit — which is what the
      // placeholder above says in more words, not a contradiction of it.
      followers.push(deps.follow(nameOf(c), join(opts.logDir, `${c.name}.log`)));
    }
  } catch (err) {
    await stop().catch((stopErr: unknown) => {
      // The bringup failure is the diagnosis; a teardown failure on top of it
      // is reported but must not replace it.
      console.error(
        stopErr instanceof Error ? stopErr.message : String(stopErr),
      );
    });
    throw err;
  }

  return {
    statuses: containers.map((c) => record(c, failed.get(c.name) ?? null)),
    stop,
  };
}

// Remove one sibling, and decide whether a podman that said no means a leak.
//
// Two ordinary paths reach this with the container already gone, so a failed
// `rm` cannot be reported as a leak on its own: a name is claimed BEFORE
// `podman run` is attempted (a container that started and then failed
// readiness still has to be removed, and nothing outside `bringUp` can tell
// the two apart), and `sandbox.close()` removes the anchor with `--depend`,
// which takes every joiner with it — reachable whenever `createSandbox` throws
// after this stack came up, an `onSandboxReady` hook being the obvious one.
// Reported as a leak, each would send an operator to clear debris that does not
// exist, every cycle, which is how a real report gets ignored.
//
// So the second question is asked only where the first one failed — #36's
// discipline, and its limit too: `gone` is conclusive, everything else
// (podman wedged, an inspect that timed out) stays a leak, because reading
// "could not answer" as "not there" is what silences the report this exists to
// make.
async function removeSibling(containerName: string): Promise<string | null> {
  // The gate's own builder, so the `-v` story is stated in exactly one place
  // (#50). It cannot fire here — a sibling is created by `containerRunArgs`,
  // which passes `--image-volume=ignore` — and is carried because a flag
  // present at some container removals and absent at others reads as a
  // decision about this one.
  const args = CONTAINER_RM_ARGS(containerName);
  const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
  if (boundedOk(r)) return null;
  if ((await containerState(containerName)) === "gone") return null;
  return `  ${RUNTIME} ${args.join(" ")}\n    ${
    r.timedOut ? `timed out after ${CONTROL_TIMEOUT_MS}ms` : r.errorMessage
  }`;
}

export type LogFollower = { readonly stop: () => void };

// The follower's argv. `-f` from the container's first log line, never a
// `--tail`/`--since` window: this file is the whole record of what a sibling
// did, and a window would silently drop its startup.
//
// Local to this module since #43 took the gate's own follower out with the
// `log` readiness kind. It is two array elements; sharing them across modules
// would be the only thing left tying a readiness mechanism that no longer
// exists to an artefact that does.
export function logFollowArgs(containerName: string): string[] {
  return ["logs", "-f", containerName];
}

// One `podman logs -f` per sibling, appended to a file on the host (#44 D4).
//
// Deliberately much simpler than gate-stack's `watchLog`, because it answers a
// different question: that one decides READINESS, so a follower that dies must
// restart or the container can never go ready. This one only produces an
// artefact, so a death is worth recording in the file and nothing more —
// restarting would re-read the log from the start and duplicate everything
// already written, which is exactly what a reader must not find.
//
// Unbounded by design, like the follower it is modelled on, and bounded the
// same way: by ownership. `stop` kills it and runs on every path out of the
// stack, including the cleanup registry's.
function startLogFollower(containerName: string, filePath: string): LogFollower {
  let stopped = false;
  let child: ChildProcess | null = null;
  let stream: WriteStream | null = null;
  try {
    stream = createWriteStream(filePath, { flags: "a" });
    // An 'error' on the stream is otherwise an unhandled event, which takes the
    // whole run down — a log follower must never be able to do that.
    stream.on("error", () => {});
    const ch = spawn(RUNTIME, logFollowArgs(containerName), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = ch;
    // `podman logs` writes podman's own diagnostics and the container's stderr
    // to one fd, so both streams go to one file — which is what a reader of
    // "the container's log" expects, and the ordering is podman's.
    ch.stdout?.pipe(stream, { end: false });
    ch.stderr?.pipe(stream, { end: false });
    for (const s of [ch.stdout, ch.stderr]) s?.on("error", () => {});
    ch.on("error", (err: Error) => {
      stream?.write(`\n[sandbar] could not run ${RUNTIME} logs: ${err.message}\n`);
    });
    ch.on("close", (code: number | null) => {
      if (stopped) return;
      stream?.write(
        `\n[sandbar] ${RUNTIME} logs -f exited ${String(code)}; this file is no ` +
          `longer being updated. The container may have exited.\n`,
      );
    });
  } catch {
    // A follower that cannot start costs the agent a log, never the issue.
  }
  return {
    stop: () => {
      stopped = true;
      child?.kill("SIGKILL");
      child = null;
      stream?.end();
      stream = null;
    },
  };
}
