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
// container — it owns the `--dns` and `-p` flags, and removing it destroys the
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
// two mechanical items instead — publish ports and DNS flags must be decided
// before the anchor is created (they are: the resolved stack is available by
// then), and teardown must remove joiners BEFORE the anchor — and nothing about
// the agent's own environment moves.
//
// The isolation the issue asks for comes from this being a DIFFERENT namespace
// from the gate's pod, not from the absence of a runtime inside the sandbox.
// The agent must not be able to reach the stack its verdict is formed in, and
// that is now a structural property rather than a matter of which socket
// happened to be mounted.
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
// ---------------------------------------------------------------------------
// Images, and the confusion mode that buys
// ---------------------------------------------------------------------------
// Siblings run the image their config NAMES, resolved once. #37 does not extend
// here: the gate re-resolves before every gate run because an image that bakes
// a lockfile is a function of the branch and a stale one is a WRONG VERDICT;
// the sandbox is a workspace, not a verdict, so a stale layer costs the agent a
// command (`npm ci` into its own container) rather than an answer. Same
// argument CLAUDE.md already makes for keeping the agent sandbox image out of
// `rebuildOn`'s uses.
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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { onCleanup } from "./cleanup.js";
import type { ResolvedGateStack, ResolvedStackContainer } from "./config.js";
import { SandbarError } from "./errors.js";
import {
  CONTROL_TIMEOUT_MS,
  ContainerBringupError,
  LOG_READ_TIMEOUT_MS,
  boundedOk,
  boundedPodman,
  bringUpContainers,
  logFollowArgs,
  parsePortBindings,
} from "./gate-stack.js";
import { type RunScope, sandboxContainerNameFor } from "./naming.js";
import { RUNTIME } from "./runtime.js";

// Where the followers' files appear INSIDE the agent container. A fixed path,
// because it is quoted in the implementer's prompt and an agent should be able
// to `tail -f` it without being told a new location every run.
export const SANDBOX_LOG_MOUNT = "/sandbar/logs";

export function sandboxLogPathFor(containerName: string): string {
  return `${SANDBOX_LOG_MOUNT}/${containerName}.log`;
}

// The subset of the gate stack that also runs beside the agent. Empty for every
// consumer that declares no `inSandbox` container, and an empty subset means no
// sandbox stack at all — no extra containers, no log mount, no publish ports,
// no prompt slot. That is what makes #44 opt-in by construction.
export function sandboxContainers(
  spec: ResolvedGateStack,
): readonly ResolvedStackContainer[] {
  return spec.containers.filter((c) => c.inSandbox);
}

// Container ports the ANCHOR must publish, deduplicated — the sandbox subset's
// `tcp` readiness ports, probed from the host exactly as the gate's are. The
// gate's own rule that two containers may not declare the same tcp readiness
// port is a rule over the whole stack, so it already covers this subset.
export function sandboxPublishPorts(
  containers: readonly ResolvedStackContainer[],
): number[] {
  const ports = new Set<number>();
  for (const c of containers) {
    if (c.readiness?.kind === "tcp") ports.add(c.readiness.port);
  }
  return [...ports];
}

// What the implementer's prompt is rendered from (#44 D8). One entry per
// declared sandbox container, whether or not it came up — a container the agent
// is not told about is one it will rebuild by hand, which is the failure this
// whole feature exists to end.
export type SandboxContainerStatus = {
  readonly name: string;
  readonly image: string;
  readonly lifecycle: "issue" | "attempt";
  // `127.0.0.1:<port>` when the container declares a `tcp` readiness, which is
  // the only place a port number is written down. Null otherwise — the sibling
  // is still on the sandbox's loopback, sandbar just does not know which port
  // it listens on, and inventing one would be worse than saying nothing.
  readonly address: string | null;
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
  // The agent container. Every sibling joins its network namespace and its
  // publish ports are what the `tcp` probes connect through, so it must already
  // be running.
  readonly anchorContainerName: string;
  // Host directory the followers write into. Must be the same directory the
  // anchor has mounted at SANDBOX_LOG_MOUNT — created by `prepareSandboxLogDir`
  // BEFORE the anchor, because a bind-mount source is read at container start.
  readonly logDir: string;
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
    // Failures are reported, never swallowed: what leaks here is a running
    // container holding a worktree mount, and the only backstop is the next
    // cycle's scoped sweep — which on the last cycle, or on a halt, never runs.
    const failures: string[] = [];
    for (const name of [...created].reverse()) {
      const args = ["rm", "-f", "-t", "0", name];
      const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
      if (boundedOk(r)) continue;
      failures.push(
        `  ${RUNTIME} ${args.join(" ")}\n    ${
          r.timedOut ? `timed out after ${CONTROL_TIMEOUT_MS}ms` : r.errorMessage
        }`,
      );
    }
    if (failures.length > 0) {
      throw new SandbarError(
        `sandbox stack: teardown of the sandbox siblings for issue ` +
          `${opts.issueId} failed, leaking podman resources:\n` +
          `${failures.join("\n")}`,
      );
    }
  };
  // Registered before the first container exists, so a signal anywhere in the
  // bringup below still sweeps what was created. ONE entry for the whole stack
  // — that registry never forgets an action, so one per container would grow
  // without limit across a run.
  onCleanup(stop);

  const hostPorts = await readAnchorPortBindings(opts.anchorContainerName);
  const ctx = {
    attach: {
      kind: "netns" as const,
      anchorContainerName: opts.anchorContainerName,
    },
    worktreePath: opts.worktreePath,
    nameOf,
    hostPorts,
  };

  const statuses: SandboxContainerStatus[] = [];
  const record = (
    c: ResolvedStackContainer,
    failure: string | null,
  ): SandboxContainerStatus => ({
    name: c.name,
    image: c.image,
    lifecycle: c.lifecycle,
    address:
      c.readiness?.kind === "tcp" ? `127.0.0.1:${c.readiness.port}` : null,
    logPath: sandboxLogPathFor(c.name),
    up: failure === null,
    failure,
  });

  // A container that reached `podman run` has a name to remove even if it never
  // became ready, so teardown has to know about it before readiness is decided.
  const claim = (group: readonly ResolvedStackContainer[]): void => {
    for (const c of group) if (!created.includes(nameOf(c))) created.push(nameOf(c));
  };

  try {
    const issueContainers = containers.filter((c) => c.lifecycle === "issue");
    if (issueContainers.length > 0) {
      claim(issueContainers);
      // As a group, and a throw here is infra: these depend only on image and
      // env, so a fresh sandbox is exactly the right response.
      await bringUpContainers(issueContainers, ctx);
      for (const c of issueContainers) statuses.push(record(c, null));
    }

    // One at a time, so one broken app server does not take the database's
    // sibling down with it — see the header.
    for (const c of containers.filter((c) => c.lifecycle === "attempt")) {
      claim([c]);
      try {
        await bringUpContainers([c], ctx);
        statuses.push(record(c, null));
      } catch (err) {
        if (!(err instanceof ContainerBringupError)) throw err;
        statuses.push(record(c, err.message));
      }
    }

    for (const status of statuses) {
      const c = containers.find((x) => x.name === status.name);
      // `containers` is what `statuses` was built from, so this cannot miss.
      if (c === undefined) continue;
      if (status.up) {
        followers.push(startLogFollower(nameOf(c), join(opts.logDir, `${c.name}.log`)));
      } else {
        // The path is quoted in the agent's prompt either way, so it has to
        // resolve to something that explains itself rather than to ENOENT. The
        // prompt carries the same text; this is the copy an agent finds by
        // following the path it was given.
        await writeFile(
          join(opts.logDir, `${c.name}.log`),
          `[sandbar] container '${c.name}' did not come up.\n\n${status.failure ?? ""}\n`,
          "utf8",
        ).catch(() => {});
      }
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

  return { statuses, stop };
}

// The anchor's own publishes, in the shape the gate reads off a pod. Same JSON
// shape (`{"3306/tcp":[{"HostIp":…,"HostPort":"44719"}]}`), so `parsePortBindings`
// is shared rather than re-derived.
async function readAnchorPortBindings(
  anchorContainerName: string,
): Promise<Map<number, number>> {
  const r = await boundedPodman(
    [
      "inspect",
      anchorContainerName,
      "--format",
      "{{json .NetworkSettings.Ports}}",
    ],
    LOG_READ_TIMEOUT_MS,
  );
  // A plain Error, deliberately, for the reason `readPortBindings` gives: a
  // SandbarError is rethrown past HARD-ERROR by the inner loop and would drop
  // the issue for the cycle with no terminal and no label flip, when podman
  // failing to answer is precisely what a fresh sandbox fixes.
  if (!boundedOk(r)) {
    throw new Error(
      `sandbox stack: could not read the port bindings of the agent ` +
        `container ${anchorContainerName}` +
        (r.timedOut
          ? ` (${RUNTIME} inspect did not return within ${LOG_READ_TIMEOUT_MS}ms)`
          : `: ${r.errorMessage}`),
    );
  }
  return parsePortBindings(r.stdout);
}

type LogFollower = { readonly stop: () => void };

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
