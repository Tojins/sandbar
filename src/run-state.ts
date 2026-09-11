// Pure events -> UI state reduction (#132).
//
// The event record is complete; this module decides what is visible. It owns
// the pool timeline, waiting/parked join and compact event prose, while the
// HTTP server owns only file discovery and delivery. Wall-clock `now` and PID
// liveness are explicit inputs so tests do not depend on either ambient fact.
// Container resource fields stay attached to feed rows verbatim (#141), and a
// gate's per-step map is passed by reference; the reducer neither reinterprets
// unavailable measurements nor turns them into zeroes. A failed, quota-closed
// or credential-closed implementer invocation is failure evidence rather than
// a completed attempt; an OOM kill names that failure in the feed.

import type {
  GateStepEvent,
  RecomputeWaiting,
  RunEvent,
  WaitingReason,
} from "./events.js";
import type { ContainerResources } from "./container-resources.js";

export type TimelineSpan = {
  readonly kind: "impl" | "review";
  readonly from: string;
  readonly to: string | null;
  readonly label: string;
  readonly verdict?: "no";
};

export type PoolIssueState = {
  readonly issue: number;
  readonly title: string;
  readonly phase: string;
  readonly phaseSince: string;
  readonly attempt: number;
  readonly spans: readonly TimelineSpan[];
};

export type WaitingIssueState = {
  readonly issue: number;
  readonly title: string;
  readonly why: string;
  readonly parked?: true;
};

export type FinishedIssueState = {
  readonly issue: number;
  readonly title: string;
  readonly outcome: string;
  readonly reason: string;
  readonly attempts: number;
  readonly rounds: number;
  readonly ms: number;
  readonly landed: string;
  readonly at: string;
};

export type FeedEvent = ContainerResources & {
  readonly at: string;
  readonly issue: number | null;
  readonly text: string;
  readonly tone: "" | "dim" | "good" | "warn" | "bad";
  readonly steps?: Readonly<Record<string, GateStepEvent>>;
};

export type UiState = {
  readonly now: string;
  readonly run: {
    readonly startedAt: string;
    readonly status: "live" | "ended" | "crashed";
    readonly driver: string;
    readonly slots: { readonly used: number; readonly max: number };
    readonly lastRecompute: {
      readonly n: number;
      readonly trigger: string;
      readonly at: string;
    } | null;
    readonly exit: { readonly tag: string; readonly reason: string } | null;
    // The deploy channel's pending instruction (#146): set from the moment the
    // request is observed, so a reader watching a long drain sees WHY nothing
    // new is being admitted instead of an idle-looking pool.
    readonly restart: { readonly detail: string; readonly at: string } | null;
    readonly complaints: readonly { readonly severity: "warning" | "error"; readonly text: string }[];
  };
  readonly pool: readonly PoolIssueState[];
  readonly waiting: readonly WaitingIssueState[];
  readonly finished: readonly FinishedIssueState[];
  readonly eventCount: number;
  readonly events: readonly FeedEvent[];
};

const RECENT_EVENT_LIMIT = 200;

const firstLine = (text: string | null): string => text?.split(/\r?\n/, 1)[0] ?? "";

const parkedReason = (
  outcome: string,
  reason: string | null,
  when: "this run" | "before this run",
): string => `parked · ${outcome}${reason ? ` · ${firstLine(reason)}` : ""} · ${when}`;

type MutableIssue = {
  issue: number;
  title: string;
  phase: string;
  phaseSince: string;
  attempt: number;
  spans: TimelineSpan[];
};

const triggerText = (trigger: string): string => trigger.replaceAll("-", " ");

type ImplementerEvent = Extract<RunEvent, { kind: "implementer" }>;

const implementerFailure = (event: ImplementerEvent): string | null => {
  if (event.signal !== "FAILED" &&
      event.signal !== "QUOTA" &&
      event.signal !== "CREDENTIAL") {
    return null;
  }
  if (event.oomKilled === true) return "OOM-killed";
  if (event.signal === "QUOTA") return "quota";
  if (event.signal === "CREDENTIAL") return "credential";
  return "invocation failed";
};

export function waitingReasonText(reason: WaitingReason): string {
  switch (reason.kind) {
    case "blocked": return `blocked by ${reason.by.map((n) => `#${n}`).join(", ")}`;
    case "no-slot": return "no free slot";
    case "held": return "held: no chunk to land on";
    case "ongoing": return "ongoing";
    case "label-actor":
      return reason.actor === null
        ? "excluded: ready-for-agent label actor unknown"
        : `excluded: ready-for-agent applied by @${reason.actor}`;
  }
}

function feedText(event: RunEvent): FeedEvent | null {
  const issue = "issue" in event && typeof event.issue === "number"
    ? event.issue
    : null;
  let text: string;
  let tone: FeedEvent["tone"] = "";
  switch (event.kind) {
    case "run-start":
      text = "run started";
      tone = "dim";
      break;
    case "wake-lock":
      text = `wake lock ${event.state}`;
      tone = event.state === "held" || event.state === "released" ? "dim" : "warn";
      break;
    case "idle":
      text = `idle · polling every ${event.pollIntervalMs}ms`;
      tone = "dim";
      break;
    case "restart-requested":
      text = `restart requested · ${event.detail} · draining`;
      tone = "warn";
      break;
    case "preflight":
      text = `preflight ${event.action} · ${event.detail}`;
      tone = "dim";
      break;
    case "sweep":
      text = `${event.scope} sweep · ${event.removed.length} removed · ${event.failures.length} failed`;
      tone = event.failures.length > 0 ? "warn" : "dim";
      break;
    case "image":
      text = `image ${event.action} · ${event.image}`;
      tone = "dim";
      break;
    case "landing-batch":
      text = `landing batch ${event.n} complete · ${event.durationMs}ms`;
      tone = "dim";
      break;
    case "admitted":
      text = `admitted #${event.issue}`;
      tone = "dim";
      break;
    case "origin-sync":
      text = `origin sync · ${event.detail}`;
      tone = event.outcome === "origin-unreadable" || event.outcome === "diverged"
        ? "warn"
        : "dim";
      break;
    case "implementer": {
      const failure = implementerFailure(event);
      text = failure === null
        ? `attempt ${event.attempt} complete · ${event.commits} commit${event.commits === 1 ? "" : "s"}`
        : `attempt ${event.attempt} failed · ${failure} · ${event.commits} commit${event.commits === 1 ? "" : "s"}`;
      if (failure !== null) tone = "bad";
      break;
    }
    case "review-pass":
      text = `round ${event.round} · ${event.pass} pass · invocation ${event.invocation}`;
      break;
    case "resolve-attempt":
      text = `resolve attempt ${event.attempt} · ${event.end}`;
      tone = event.oomKilled === true ? "bad" : "";
      break;
    case "container":
      text = `${event.stack} container ${event.name} stopped`;
      tone = event.oomKilled === true ? "bad" : "dim";
      break;
    case "review-round":
      text = `round ${event.round} · ${
        !event.gateOk
          ? "gate changes requested"
          : event.rejectingPass
            ? `${event.rejectingPass} changes requested`
            : "approved"
      }`;
      tone = !event.gateOk || event.rejectingPass ? "bad" : "good";
      break;
    case "terminal":
      text = `${event.terminal}${event.reason ? ` · ${event.reason}` : ""}`;
      tone = event.terminal === "DONE" ? "good" : "bad";
      break;
    case "landed":
      text = `${event.outcome} ${event.branch}${event.target ? ` → ${event.target}` : ""}`;
      tone = event.outcome === "skipped" || event.outcome === "chunk-parked" ? "bad" : "good";
      break;
    case "complaint":
      text = event.message;
      tone = event.severity === "error" ? "bad" : "warn";
      break;
    case "follow-up":
      text = event.detail;
      tone = "dim";
      break;
    case "recompute":
      text = `recompute ${event.n} · ${triggerText(event.trigger)}`;
      tone = "dim";
      break;
    case "hard-error":
      text = `hard error · retry ${event.retry}/${event.max} · ${firstLine(event.reason)}`;
      tone = "bad";
      break;
    case "phase":
      text = `phase · ${phaseLabel(event.phases)}`;
      tone = "dim";
      break;
    case "setup":
      text = `setup complete · ${event.durationMs}ms`;
      tone = "dim";
      break;
    case "ui-check":
      text = `UI check ${event.invocation} · ${event.result ?? "finished"}`;
      tone = "dim";
      break;
    case "gate":
      text = `${event.gate} ${event.ok ? "passed" : "failed"}`;
      tone = event.ok ? "good" : "bad";
      break;
    case "repair":
      text = `repair · ${event.action}`;
      tone = "warn";
      break;
    case "finalise":
      text = `finalise ${event.finaliseKind} · ${event.detail ?? event.outcome}`;
      tone = "dim";
      break;
    case "reconcile":
      text = `reconcile ${event.action} · ${event.detail}`;
      tone = "dim";
      break;
    case "exit":
      text = `exit ${event.tag} · ${event.reason}`;
      tone = event.exitCode === 0 ? "good" : "bad";
      break;
    case "run-end":
      text = `run ended · ${event.reason}`;
      tone = "dim";
      break;
    default:
      return null;
  }
  return {
    at: event.ts,
    issue,
    text,
    tone,
    ...(event.kind === "gate" && event.steps !== undefined
      ? { steps: event.steps }
      : {}),
    ...("peakMemoryBytes" in event && event.peakMemoryBytes !== undefined
      ? { peakMemoryBytes: event.peakMemoryBytes }
      : {}),
    ...("oomKilled" in event && event.oomKilled !== undefined
      ? { oomKilled: event.oomKilled }
      : {}),
  };
}

function finishRunningSpan(issue: MutableIssue, at: string): void {
  const last = issue.spans.at(-1);
  if (last?.to === null) {
    issue.spans[issue.spans.length - 1] = { ...last, to: at };
  }
}

// An empty phase set is the loop tearing the sandbox down after its verdict;
// the terminal event that follows names the outcome (and DONE then reads
// "landing" until its landing outcome is recorded).
function phaseLabel(phases: readonly string[]): string {
  return phases.length === 0 ? "finishing" : phases.join(" + ");
}

function applyPhase(issue: MutableIssue, event: Extract<RunEvent, { kind: "phase" }>): void {
  finishRunningSpan(issue, event.ts);
  issue.phase = phaseLabel(event.phases);
  issue.phaseSince = event.ts;
  issue.attempt = event.attempt;
  if (event.phases.includes("implementer")) {
    issue.spans.push({ kind: "impl", from: event.ts, to: null, label: `a${event.attempt}` });
  } else if (event.phases.some((phase) => phase === "gate-1" || phase === "review")) {
    issue.spans.push({ kind: "review", from: event.ts, to: null, label: "gate + review" });
  }
}

function finishedFrom(events: readonly RunEvent[]): readonly FinishedIssueState[] {
  const titles = new Map<number, string>();
  const terminals = new Map<number, Extract<RunEvent, { kind: "terminal" }>>();
  const landings = new Map<
    number,
    Extract<RunEvent, { kind: "landed" }> & { readonly issue: number }
  >();
  const attempts = new Map<number, number>();
  const rounds = new Map<number, number>();
  const finalisations = new Map<number, Extract<RunEvent, { kind: "finalise" }>>();
  for (const event of events) {
    if ("issue" in event && typeof event.issue === "number" && event.title) {
      titles.set(event.issue, event.title);
    }
    if (event.kind === "implementer" && implementerFailure(event) === null) {
      attempts.set(event.issue, (attempts.get(event.issue) ?? 0) + 1);
    }
    if (event.kind === "review-round") {
      rounds.set(event.issue, (rounds.get(event.issue) ?? 0) + 1);
    }
    if (event.kind === "terminal") terminals.set(event.issue, event);
    if (event.kind === "finalise") finalisations.set(event.issue, event);
    if (event.kind === "landed" && "issue" in event && typeof event.issue === "number") {
      landings.set(event.issue, event);
    }
  }
  return [...terminals.values()].flatMap((terminal) => {
    // An escaped issue-task exception ended this execution slot but did not
    // run tracker finalisation. Its branch is rediscovered as waiting/parked by
    // the next recompute; it is not a completed issue for cross-run history.
    if (terminal.terminal === "REJECTED") return [];
    const landed = landings.get(terminal.issue);
    // DONE is still in the pool while the merger owns it. Publishing it as
    // finished before a landing outcome arrives would put one issue in both
    // sections and leave the signed-off "where it landed" column blank.
    if (terminal.terminal === "DONE" && landed?.outcome === "skipped") {
      const finalise = finalisations.get(terminal.issue);
      if (!finalise || finalise.finaliseKind === "fresh-attempt") return [];
      return [{
        issue: terminal.issue,
        title: terminal.title ?? titles.get(terminal.issue) ?? "",
        outcome: "NEEDS-HUMAN",
        reason: landed.reason ?? terminal.reason ?? "",
        attempts: attempts.get(terminal.issue) ?? 0,
        rounds: rounds.get(terminal.issue) ?? 0,
        ms: terminal.durationMs,
        landed: "",
        at: finalise.ts,
      }];
    }
    if (terminal.terminal === "DONE" && landed === undefined) return [];
    return [{
      issue: terminal.issue,
      title: terminal.title ?? titles.get(terminal.issue) ?? "",
      outcome: terminal.terminal,
      reason: terminal.reason ?? "",
      attempts: attempts.get(terminal.issue) ?? 0,
      rounds: rounds.get(terminal.issue) ?? 0,
      ms: terminal.durationMs,
      landed: landed?.target ?? landed?.branch ?? "",
      at: landed?.ts ?? terminal.ts,
    }];
  });
}

export type ReduceRunOptions = {
  readonly now: Date;
  readonly pidAlive: boolean;
  readonly recentFinished?: readonly FinishedIssueState[];
};

export function reduceRunEvents(
  events: readonly RunEvent[],
  options: ReduceRunOptions,
): UiState {
  const start = events[0];
  if (!start || start.kind !== "run-start") {
    throw new Error("event stream does not begin with run-start");
  }
  const issues = new Map<number, MutableIssue>();
  const executing = new Set<number>();
  let lastRecompute: Extract<RunEvent, { kind: "recompute" }> | null = null;
  let waiting: readonly RecomputeWaiting[] = [];
  let exit: Extract<RunEvent, { kind: "exit" }> | null = null;
  let restart: Extract<RunEvent, { kind: "restart-requested" }> | null = null;
  let ended = false;
  const complaints: Array<{ severity: "warning" | "error"; text: string }> = [];
  const feed: FeedEvent[] = [];
  const parkedTerminals = new Map<
    number,
    Extract<RunEvent, { kind: "terminal" }>
  >();

  for (const event of events) {
    const feedEvent = feedText(event);
    if (feedEvent) feed.push(feedEvent);
    switch (event.kind) {
      case "admitted":
        {
          executing.add(event.issue);
          const issue = issues.get(event.issue);
          if (issue) {
            issue.title = event.title ?? issue.title;
            issue.phase = "setup";
            issue.phaseSince = event.ts;
            issue.attempt = 1;
          } else {
            issues.set(event.issue, {
              issue: event.issue,
              title: event.title ?? "",
              phase: "setup",
              phaseSince: event.ts,
              attempt: 1,
              spans: [],
            });
          }
        }
        break;
      case "phase": {
        const issue = issues.get(event.issue);
        if (issue) applyPhase(issue, event);
        if (event.phases.length > 0) executing.add(event.issue);
        else executing.delete(event.issue);
        break;
      }
      case "terminal": {
        executing.delete(event.issue);
        parkedTerminals.set(event.issue, event);
        const issue = issues.get(event.issue);
        if (event.terminal === "REJECTED") {
          issues.delete(event.issue);
          break;
        }
        if (issue) {
          finishRunningSpan(issue, event.ts);
          issue.phase = event.terminal === "DONE" ? "landing" : event.terminal;
          issue.phaseSince = event.ts;
        }
        break;
      }
      case "review-round": {
        if (event.rejectingPass !== null) {
          const issue = issues.get(event.issue);
          const last = issue?.spans.at(-1);
          if (issue && last?.kind === "review") {
            issue.spans[issue.spans.length - 1] = { ...last, verdict: "no" };
          }
        }
        break;
      }
      case "hard-error": {
        executing.add(event.issue);
        const issue = issues.get(event.issue);
        if (issue) {
          finishRunningSpan(issue, event.ts);
          issue.phase = "setup";
          issue.phaseSince = event.ts;
          issue.attempt = 1;
        }
        break;
      }
      case "gate": {
        if (!event.ok) {
          const issue = issues.get(event.issue);
          const last = issue?.spans.at(-1);
          if (issue && last?.kind === "review") {
            issue.spans[issue.spans.length - 1] = { ...last, verdict: "no" };
          }
        }
        break;
      }
      case "landed":
        if ("issue" in event && typeof event.issue === "number") {
          executing.delete(event.issue);
          if (event.outcome === "skipped") {
            const issue = issues.get(event.issue);
            if (issue) {
              finishRunningSpan(issue, event.ts);
              issue.phase = "finalising";
              issue.phaseSince = event.ts;
            }
          } else {
            issues.delete(event.issue);
          }
        }
        break;
      case "finalise": {
        const issue = issues.get(event.issue);
        if (!issue) break;
        if (event.finaliseKind === "fresh-attempt") {
          executing.add(event.issue);
          issue.phase = "setup";
          issue.phaseSince = event.ts;
          issue.attempt = 1;
        } else {
          executing.delete(event.issue);
          issues.delete(event.issue);
        }
        break;
      }
      case "recompute":
        lastRecompute = event;
        waiting = event.waiting;
        for (const admitted of event.admitted) {
          executing.add(admitted.issue);
          if (!issues.has(admitted.issue)) {
            issues.set(admitted.issue, {
              issue: admitted.issue,
              title: admitted.title ?? "",
              phase: "setup",
              phaseSince: event.ts,
              attempt: 1,
              spans: [],
            });
          }
        }
        break;
      case "idle":
        break;
      case "restart-requested":
        restart = event;
        break;
      case "complaint":
        complaints.push({ severity: event.severity, text: event.message });
        break;
      case "exit":
        exit = event;
        break;
      case "run-end":
        ended = true;
        break;
    }
  }

  const status = ended ? "ended" : options.pidAlive ? "live" : "crashed";
  const waitingRows: WaitingIssueState[] = waiting
    .filter((entry) => entry.reason.kind !== "ongoing")
    .map((entry) => ({
      issue: entry.issue,
      title: entry.title ?? "",
      why: waitingReasonText(entry.reason),
    }));
  if (status !== "live") {
    for (const issue of [...issues.values()]) {
      const terminal = parkedTerminals.get(issue.issue);
      if (!terminal) continue;
      issues.delete(issue.issue);
      waitingRows.push({
        issue: issue.issue,
        title: issue.title,
        why: parkedReason(terminal.terminal, terminal.reason, "this run"),
        parked: true,
      });
    }
  }
  if (lastRecompute) {
    const previousOutcomes = new Map(
      (options.recentFinished ?? []).map((item) => [item.issue, item] as const),
    );
    const candidates = new Map(
      lastRecompute.candidates.map((candidate) => [candidate.issue, candidate] as const),
    );
    const readyIssues = new Set([
      ...lastRecompute.candidates.filter((candidate) => candidate.ready)
        .map((candidate) => candidate.issue),
      ...lastRecompute.waiting.map((candidate) => candidate.issue),
    ]);
    const activeIssues = new Set(lastRecompute.active.map((active) => active.issue));
    for (const ref of lastRecompute.refs) {
      if (readyIssues.has(ref.issue) || activeIssues.has(ref.issue)) continue;
      const parked = parkedTerminals.get(ref.issue);
      const previous = previousOutcomes.get(ref.issue);
      waitingRows.push({
        issue: ref.issue,
        title: candidates.get(ref.issue)?.title ?? "",
        why: parked
          ? parkedReason(parked.terminal, parked.reason, "this run")
          : parkedReason(
              previous?.outcome ?? "unknown terminal",
              previous?.reason ?? null,
              "before this run",
            ),
        parked: true,
      });
    }
  }

  const ownFinished = finishedFrom(events);
  const allFinished = [...ownFinished, ...(options.recentFinished ?? [])]
    .sort((a, b) => b.at.localeCompare(a.at));
  const dedupedFinished: FinishedIssueState[] = [];
  const seenFinished = new Set<number>();
  for (const item of allFinished) {
    if (seenFinished.has(item.issue)) continue;
    seenFinished.add(item.issue);
    dedupedFinished.push(item);
  }
  return {
    now: options.now.toISOString(),
    run: {
      startedAt: start.ts,
      status,
      driver: start.driver,
      slots: { used: executing.size, max: start.maxParallelIssues },
      lastRecompute: lastRecompute
        ? {
            n: lastRecompute.n,
            trigger: triggerText(lastRecompute.trigger),
            at: lastRecompute.ts,
          }
        : null,
      exit: exit ? { tag: exit.tag, reason: exit.reason } : null,
      restart: restart ? { detail: restart.detail, at: restart.ts } : null,
      complaints,
    },
    pool: [...issues.values()].sort((a, b) => a.issue - b.issue),
    waiting: waitingRows.sort((a, b) => a.issue - b.issue),
    finished: dedupedFinished,
    eventCount: feed.length,
    events: feed.reverse().slice(0, RECENT_EVENT_LIMIT),
  };
}

export function finishedIssues(events: readonly RunEvent[]): readonly FinishedIssueState[] {
  return finishedFrom(events);
}
