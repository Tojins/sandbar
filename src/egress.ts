// The egress proxy's host side (#202): its image, and one proxy per network
// owner. `egress-policy.ts` is the pure layer, `egress-proxy-server.ts` the
// program the image runs.
//
// ENFORCEMENT IS THE NETWORK (Decision 1). An owner (the agent sandbox, whose
// `--network container:` siblings share its netns; a gate pod; a resolve
// container) sits on its own `--internal --disable-dns` network, which has no
// route out: measured rootless, its containers reach nothing but peers on that
// network, and their root cannot add a route. The proxy is the one peer, on
// that network and on podman's bridge, and the owner's only DNS server
// (`dnsArgs`). Siblings are covered because the rule is structural. Rejected:
// nftables in the rootless netns, which netavark rewrites on every network
// create, matches IPs rather than names, and cannot record a refused host.
//
// STEER BY DNS, ROUTE BY SNI/Host (Decision 2). No `HTTPS_PROXY`: clients that
// ignore proxy env (Node's `fetch`, PHP under test, a Playwright browser) would
// fail on an internal network with an unlogged resolve error. Through the DNS
// sink every client asks the proxy, so every name it wants is logged, and the
// bytes it then sends are spliced through unchanged, so the client verifies
// the real certificate.
//
// ONE PROXY PER OWNER (Decision 3), never shared: the gate's fresh-stack retry
// runs `network rm -f`, which takes every container on the network with it,
// and a proxy bridging two internal networks would be one hop between
// namespaces sandbox-stack.ts keeps apart. Each proxy's peak memory is
// recorded at `stop` (#141).
//
// A SANDBAR-OWNED NODE PROGRAM IN A DRIVER-BUILT IMAGE (Decision 4), on the
// agent-tools model (#75): a generated recipe `FROM` a digest-pinned base with
// the two compiled files added, tagged by a hash of (recipe, files) and kept
// across restarts. image-lifecycle.ts prunes a stale fingerprint's tag as it
// does a tools tag; the current one is in run.ts's live set. Rejected: squid
// (intercept mode needs iptables NAT) and nginx (a CONNECT module), neither of
// which answers DNS or writes the refusal record without a second parser.
//
// A FILE, NOT A FOLLOWER (Decision 5). The proxy appends JSONL to
// `<logDir>/<owner>.jsonl`, mounted into the proxy only and never into the
// owner. `drain` reads the new complete lines at the caller's checkpoints, so
// there is no long-lived `podman logs -f`; a record arrives late, which is
// fine for a record that is never a decision input (#82).
//
// THE OWNERS (#223). With `config.egress` an allowlist, run.ts builds the image
// at startup and every owner gets an `OwnerEgress` over the run's
// `EgressContext` (logs in `<runDir>/egress/`) and an `egressReport`: the
// inner loop starts the sandbox's proxy (`sbx-<issue>`) and checkpoints it
// after every agent invocation; gate-stack.ts starts each stack's between its
// `--internal` network and its pod and checkpoints it after every gate run;
// merger.ts brackets each resolve attempt (`resolve-<n>`). A checkpoint
// records its drain's first sightings as `egress-refused` events, and the
// stop records the `egress` summary. Open egress starts nothing, and every
// argv stays what it was.
//
// Decision 8's private ranges are the proxy's to enforce (egress-policy.ts).
// RESIDUAL RISK (Decision 9), recorded rather than closed: an allowed host is
// an exfiltration channel — GitHub with whatever token the owner holds, the
// model APIs, domain fronting through a CDN behind an allowed SNI. The list
// narrows the channels; it does not seal them.
//
// A failed bringup or a dead proxy throws a plain `Error`, never a
// `SandbarError`: it is infrastructure, so HARD-ERROR and a fresh retry. A
// dead one is an `EgressProxyDiedError`, so a caller that classifies an
// agent's failure can tell the host's apart.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { registerDisposable, reportCleanupNotice } from "./cleanup.js";
import {
  type ContainerResources,
  readContainerResources,
  systemContainerResourceDeps,
} from "./container-resources.js";
import {
  type EgressCounts,
  type EgressMode,
  type EgressPolicy,
  type EgressRefusal,
  EMPTY_EGRESS_TALLY,
  egressDnsArgs,
  egressProxyRunArgs,
  foldEgressLog,
  internalNetworkCreateArgs,
  parseEgressLogLine,
  proxyIpInspectArgs,
} from "./egress-policy.js";
import {
  type ImageRecorder,
  buildGeneratedImage,
  readInputsLabel,
} from "./ensure-images.js";
import {
  CONTAINER_RM_ARGS,
  CONTROL_TIMEOUT_MS,
  READY_POLL_INTERVAL_MS,
  boundedOk,
  boundedPodman,
  containerState,
  logTail,
} from "./gate-stack.js";
import type { EgressSubject, EventInput } from "./events.js";
import { type RunScope, egressImageTag, egressProxyNameFor } from "./naming.js";
import { RUNTIME } from "./runtime.js";
import { startTimer } from "./timing.js";

export const EGRESS_BASE_IMAGE =
  "docker.io/library/node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914";

// The compiled program, resolved through the package root so that this module
// finds the same `dist/` files whether it runs from `dist/` or from `src/`
// under vitest.
const PROGRAM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PROGRAM_FILES = ["egress-policy.js", "egress-proxy-server.js"] as const;

export function egressImageContainerfile(): string {
  return [
    `FROM ${EGRESS_BASE_IMAGE}`,
    `COPY package.json ${PROGRAM_FILES.join(" ")} /egress-proxy/`,
    `ENTRYPOINT ["node", "/egress-proxy/egress-proxy-server.js"]`,
    "",
  ].join("\n");
}

async function egressImageInputs(scope: RunScope): Promise<{
  readonly tag: string;
  readonly fingerprint: string;
  readonly files: Readonly<Record<string, string>>;
}> {
  const program = await Promise.all(PROGRAM_FILES.map(async (name) =>
    [name, await readFile(join(PROGRAM_DIR, name), "utf8")] as const
  ));
  const files: Readonly<Record<string, string>> = {
    Containerfile: egressImageContainerfile(),
    "package.json": `${JSON.stringify({ type: "module" })}\n`,
    ...Object.fromEntries(program),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
  return { tag: egressImageTag(scope, fingerprint), fingerprint, files };
}

// The tag this driver builds, for the image reconciler's live set.
export async function currentEgressImageTag(scope: RunScope): Promise<string> {
  return (await egressImageInputs(scope)).tag;
}

export async function ensureEgressImage(
  scope: RunScope,
  onImage?: ImageRecorder,
): Promise<string> {
  const elapsed = startTimer();
  const { tag, fingerprint, files } = await egressImageInputs(scope);
  const current = (await readInputsLabel(tag)) === fingerprint;
  if (!current) {
    await buildGeneratedImage({
      tag,
      identity: "<generated-egress-proxy>",
      files,
      fingerprint,
      scope,
    });
  }
  await onImage?.({
    tag,
    built: !current,
    reason: current ? "egress-current" : "egress-stale",
    durationMs: elapsed(),
  });
  return tag;
}

export class EgressProxyDiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressProxyDiedError";
  }
}

// Set in an allowlisted agent container so the CLI's telemetry does not
// litter the run record with refusals.
export const EGRESS_AGENT_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

export type EgressSummary = {
  readonly mode: EgressMode;
  readonly allowed: EgressCounts;
  readonly refused: EgressCounts;
  readonly upstreamErrors: EgressCounts;
  // Sighted in the lines only the teardown's own drain read.
  readonly firstRefusals: readonly EgressRefusal[];
  readonly durationMs: number;
} & ContainerResources;

// What one drain read: the refusals first sighted since the previous drain,
// and every destination refused in its lines (`egressDestination`), so a
// gate run can name what it was refused even when an earlier run saw it first.
export type EgressDrain = {
  readonly firstRefusals: readonly EgressRefusal[];
  readonly refused: readonly string[];
};

export type EgressHandle = {
  // The proxy's address on the owner's network.
  readonly ip: string;
  // `--dns`/`--dns-search` for the owner's `run` or `pod create`.
  readonly dnsArgs: readonly string[];
  readonly drain: () => Promise<EgressDrain>;
  // Throws when podman says the proxy is stopped or gone. An unanswered
  // inspect is no evidence either way and passes.
  readonly assertAlive: () => Promise<void>;
  // Removes the proxy, then the network if `startEgress` created it.
  // Idempotent; also registered with cleanup.ts.
  readonly stop: () => Promise<EgressSummary>;
};

// Where an owner's proxy records go (#202): each drain's first-sighted
// refusals as `egress-refused` events, and at teardown the ones only the last
// drain read, then the `egress` summary.
export type EgressReport = {
  readonly refusals: (refusals: readonly EgressRefusal[]) => Promise<void>;
  readonly stopped: (summary: EgressSummary) => Promise<void>;
};

export function egressReport(
  emit: (event: EventInput) => Promise<unknown> | void,
  subject: EgressSubject,
): EgressReport {
  const refusals = async (found: readonly EgressRefusal[]): Promise<void> => {
    for (const refusal of found) await emit({ kind: "egress-refused", ...subject, ...refusal });
  };
  return {
    refusals,
    stopped: async ({ firstRefusals, ...summary }) => {
      await refusals(firstRefusals);
      await emit({ kind: "egress", ...subject, ...summary });
    },
  };
}

// What `startEgress` needs beyond the run's context: which owner, on which
// network.
export type EgressOwner = {
  // `sbx-<issue>`, a gate stackId, or `resolve-<n>`; names the proxy and its
  // files in `logDir`.
  readonly owner: string;
  readonly networkName: string;
  // False when the owner's network already exists (the gate stack creates its
  // own `--internal`); the proxy then joins it and leaves it in place.
  readonly createNetwork: boolean;
  // The address to take on that network: a reused gate pod's resolv.conf
  // already names its proxy's (gate-stack.ts).
  readonly ip?: string | undefined;
};

// An owner's proxy as the owner uses it: what it checks and when it stops,
// its records going to the report it was started with.
export type OwnerProxy = {
  readonly dnsArgs: readonly string[];
  readonly assertAlive: () => Promise<void>;
  // Records the refusals first sighted since the previous checkpoint, and
  // answers every destination refused since then.
  readonly checkpoint: () => Promise<readonly string[]>;
  // Stops the proxy and records its summary.
  readonly stop: () => Promise<void>;
};

// How an owner starts its proxy. A function rather than the context, so
// gate-stack.ts, whose podman helpers this module uses, imports nothing from
// it but types.
export type OwnerEgress = {
  readonly start: (owner: EgressOwner) => Promise<OwnerProxy>;
};

export function ownerEgress(context: EgressContext, report: EgressReport): OwnerEgress {
  return {
    start: async (owner) => {
      const handle = await startEgress({ ...context, ...owner });
      return {
        dnsArgs: handle.dnsArgs,
        assertAlive: handle.assertAlive,
        checkpoint: async () => {
          const { firstRefusals, refused } = await handle.drain();
          await report.refusals(firstRefusals);
          return refused;
        },
        stop: async () => report.stopped(await handle.stop()),
      };
    },
  };
}

// The complete lines of the proxy's log past `offset`, and where they end.
export async function readLogFrom(
  path: string,
  offset: number,
): Promise<{ readonly lines: readonly string[]; readonly end: number }> {
  const bytes = await readFile(path);
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (end <= offset) return { lines: [], end: offset };
  return {
    lines: bytes.toString("utf8", offset, end).split("\n").filter((line) => line !== ""),
    end,
  };
}

// What a run hands every network owner when `config.egress` is an allowlist:
// the proxy image run.ts built, the policy, and `<runDir>/egress`.
export type EgressContext = {
  readonly scope: RunScope;
  readonly image: string;
  readonly policy: EgressPolicy;
  readonly logDir: string;
};

export async function startEgress(
  opts: EgressContext & EgressOwner,
): Promise<EgressHandle> {
  const elapsed = startTimer();
  const name = egressProxyNameFor(opts.scope, opts.owner);
  const logPath = join(opts.logDir, `${opts.owner}.jsonl`);
  const policyPath = join(opts.logDir, `${opts.owner}.policy.json`);
  let offset = 0;
  let tally = EMPTY_EGRESS_TALLY;

  const mustSucceed = async (args: readonly string[], what: string): Promise<string> => {
    const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
    if (boundedOk(r)) return r.stdout;
    throw new Error(
      `egress proxy ${name}: could not ${what}: ${
        r.timedOut
          ? `${RUNTIME} ${args[0]} did not return within ${CONTROL_TIMEOUT_MS}ms`
          : r.errorMessage
      }`,
    );
  };

  const drainOnce = async (): Promise<EgressDrain> => {
    const { lines, end } = await readLogFrom(logPath, offset);
    const folded = foldEgressLog(lines, tally);
    offset = end;
    tally = folded.tally;
    return { firstRefusals: folded.firstRefusals, refused: folded.refused };
  };
  // Each drain starts after the previous one settles, so overlapping drains
  // (a checkpoint and stop's own) read from the advanced `offset` and fold
  // each line once. A previous drain's rejection is its own caller's; the
  // next drain runs regardless.
  let draining: Promise<unknown> = Promise.resolve();
  const drain = (): Promise<EgressDrain> => {
    const next = draining.then(drainOnce, drainOnce);
    draining = next;
    return next;
  };

  const assertAlive = async (): Promise<void> => {
    const state = await containerState(name);
    if (state === "stopped" || state === "gone") {
      throw new EgressProxyDiedError(`egress proxy ${name} died (${state}):\n${await logTail(name)}`);
    }
  };

  // Before the first resource exists, so a signal during bringup still
  // removes whatever was created (#55). `stop` is a hoisted declaration.
  const dispose = registerDisposable(async () => {
    await stop();
  });

  let stopping: Promise<EgressSummary> | null = null;
  const teardown = async (): Promise<EgressSummary> => {
    const resources = await readContainerResources(
      name,
      systemContainerResourceDeps(boundedPodman),
    );
    const failures: string[] = [];
    const remove = async (args: string[]): Promise<void> => {
      const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
      if (boundedOk(r)) return;
      failures.push(
        `  ${RUNTIME} ${args.join(" ")}\n    ${
          r.timedOut ? `timed out after ${CONTROL_TIMEOUT_MS}ms` : r.errorMessage
        }`,
      );
    };
    await remove(CONTAINER_RM_ARGS(name));
    if (opts.createNetwork) await remove(["network", "rm", "-f", opts.networkName]);
    if (failures.length > 0) {
      throw new Error(
        `egress proxy ${name}: teardown failed, leaking podman resources:\n` +
          failures.join("\n"),
      );
    }
    const { firstRefusals } = await drain();
    return {
      mode: opts.policy.mode,
      allowed: tally.allowed,
      refused: tally.refused,
      upstreamErrors: tally.upstreamErrors,
      firstRefusals,
      durationMs: elapsed(),
      ...resources,
    };
  };
  function stop(): Promise<EgressSummary> {
    if (stopping === null) {
      dispose();
      stopping = teardown();
    }
    return stopping;
  }

  const waitReady = async (): Promise<void> => {
    const deadline = Date.now() + CONTROL_TIMEOUT_MS;
    let readOffset = 0;
    for (;;) {
      const { lines, end } = await readLogFrom(logPath, readOffset);
      readOffset = end;
      if (lines.some((line) => parseEgressLogLine(line).t === "ready")) return;
      const state = await containerState(name);
      if (state === "stopped" || state === "gone") {
        throw new Error(
          `egress proxy ${name} exited before it was ready:\n${await logTail(name)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `egress proxy ${name} was not ready within ${CONTROL_TIMEOUT_MS}ms:\n` +
            await logTail(name),
        );
      }
      await wait(READY_POLL_INTERVAL_MS);
    }
  };

  // The failed bringup's own error is the one to throw; a teardown failure
  // behind it is reported with its cause.
  const abandon = async (): Promise<void> => {
    const [cleanup] = await Promise.allSettled([stop()]);
    if (cleanup?.status !== "rejected") return;
    await reportCleanupNotice(
      "cleanup-failure",
      `Egress proxy ${name}: teardown after a failed bringup also failed`,
      cleanup.reason,
    );
  };

  try {
    await mkdir(opts.logDir, { recursive: true });
    await Promise.all([
      writeFile(policyPath, JSON.stringify(opts.policy)),
      writeFile(logPath, ""),
    ]);
    // A namesake can only be a crashed predecessor's, and is never reused.
    await mustSucceed(CONTAINER_RM_ARGS(name), `remove a stale ${name}`);
    if (opts.createNetwork) {
      await mustSucceed(
        ["network", "rm", "-f", opts.networkName],
        `remove a stale network ${opts.networkName}`,
      );
      await mustSucceed(
        internalNetworkCreateArgs(opts.networkName),
        `create network ${opts.networkName}`,
      );
    }
    await mustSucceed(
      egressProxyRunArgs({
        name,
        internalNet: opts.networkName,
        image: opts.image,
        logHostPath: logPath,
        policyHostPath: policyPath,
        ip: opts.ip,
      }),
      "start",
    );
    await waitReady();
    const ip = (await mustSucceed(
      proxyIpInspectArgs(name, opts.networkName),
      `read its address on ${opts.networkName}`,
    )).trim();
    if (!isIPv4(ip)) {
      throw new Error(`egress proxy ${name}: podman reported address '${ip}' on ${opts.networkName}`);
    }
    return { ip, dnsArgs: egressDnsArgs(ip), drain, assertAlive, stop };
  } catch (err) {
    await abandon();
    throw err;
  }
}
