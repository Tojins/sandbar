// The sandbox stack (#44): the application, running beside the AGENT. A
// container marked `inSandbox: true` in `config.gateStack.containers` gets a
// second copy next to the agent — one description, two stacks.
//
// Topology: siblings join the agent container's netns with
// `--network container:<anchor>` — the chain gate-stack.ts refuses for the
// gate, fine here because the anchor IS the per-issue sandbox: created first,
// outliving every sibling, never recreated. A pod is unavailable, not merely
// unattractive: `--pod` and `--userns=keep-id` are refused together, a pod
// member's uid maps to a subuid (EACCES on the worktree, the gate's D3 rule
// from the other side), and `claude --dangerously-skip-permissions` refuses to
// run as root. The isolation is structural: this is a DIFFERENT namespace from
// the gate's pod, so the agent cannot reach the stack its verdict is formed in.
//
// Ordering. Up: worktree → `onWorktreeReady` → anchor → siblings →
// `onSandboxReady` — siblings BEFORE the sandbox-ready hooks, because those
// hooks are where a consumer runs the migration or seed that wants the
// database. Down: JOINERS BEFORE THE ANCHOR — removing the anchor destroys the
// namespace, and podman refuses it while a joiner is attached, so getting this
// backwards leaks the whole chain. Siblings are created once per SANDBOX, not
// per gate run: this stack forms no verdict, and recreating would discard what
// the agent accumulated. A HARD-ERROR retry gets a fresh set.
//
// Whose failure a failed bringup is — D5's question, rotated onto a stack with
// no verdict to redden: `issue` lifecycle throws (wrapped as HARD-ERROR, fresh
// sandbox); `attempt` lifecycle brings the sandbox up DEGRADED and the agent
// is told in its prompt, with that container's log tail — no new event or
// terminal. Attempt containers come up ONE AT A TIME (issue ones as a group)
// because `bringUpContainers` abandons the rest on first failure and
// "degraded" has to mean the other siblings still came up.
//
// Logs: each sibling's `podman logs -f` is followed into a host file
// bind-mounted READ-ONLY into the agent at `/sandbar/logs/<name>.log`. Every
// sibling is followed, including one whose bringup failed — that is the case
// that most needs a live log. The statuses returned are a snapshot of BRINGUP,
// not a live readout. Restart is deliberately not provided: a sibling that
// reads configuration at boot stays stale once the agent edits it.
//
// The follower is the one long-lived `spawn` sandbar holds (the gate's went in
// #43), so the signal caveat lives here: `stop` covers SIGINT/SIGTERM via the
// cleanup registry, but SIGKILL or an untrapped SIGHUP can orphan a follower —
// it holds no lock and no podman resource, so what leaks is a stray process.
// The log file is UNCAPPED (truncation would remove exactly the tail the
// prompt points the agent at) and per ISSUE, not per sandbox — every write is
// an APPEND, or a HARD-ERROR retry would take the previous sandbox's log.
//
// Images: siblings run the image their config NAMES, resolved once — never a
// `rebuildOn` variant (#37 does not extend here; #46 covers the agent's own
// image). Accepted confusion mode: the agent's suite may pass against baked
// dependencies while the rebuilding gate reds — THE GATE IS AUTHORITATIVE, and
// the prompt says so.
//
// Two stacks, one worktree: separate namespaces, but the SAME bind-mounted
// worktree, and the sandbox's app keeps writing while gate-1 forms a verdict.
// D1's corollary (write only into gitignored paths) extends to sandbox
// siblings, which write continuously; a compiled-cache race over one directory
// is the consumer's to resolve with per-environment cache paths.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { registerDisposable } from "./cleanup.js";
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
    // Latched, so this can never do anything again — drop it from the registry
    // rather than leave a spent closure there for the rest of the run (#55).
    dispose();
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
  // — one per container would grow without limit across a run. And a
  // DISPOSABLE (#55) rather than a plain `onCleanup`, because stacks are
  // themselves created in a loop: one per issue, plus one per HARD-ERROR retry.
  // A disposable is an ordinary registry entry that can be withdrawn, so this
  // one keeps the position it would have had — which is what `stop`'s own
  // comment above leans on when it says the LIFO drain reaches this stack
  // before the agent-sandbox teardown. `registerDisposable`'s own header owns
  // the rest of that argument.
  const dispose = registerDisposable(stop);

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
