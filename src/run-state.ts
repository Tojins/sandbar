// Pure events -> UI state reduction (#132).
//
// The event record is complete; this module decides what is visible. It owns
// the pool timeline, waiting/parked join and compact event prose, while the
// HTTP server owns only file discovery and delivery. Header complaints retain
// their event sequence so the browser can key per-viewer dismissals by run
// directory and occurrence without changing the event record (#171). Landing rows consume the
// explicit request status/reason transitions in the record; they never infer a
// queue position or merger step from event adjacency (#168). Wall-clock `now` and PID
// liveness are explicit inputs so tests do not depend on either ambient fact.
// Container resource fields stay attached to feed rows verbatim (#141), and a
// gate's per-step map is passed by reference; the reducer neither reinterprets
// unavailable measurements nor turns them into zeroes. A failed, quota-closed
// or credential-closed implementer invocation is failure evidence rather than
// a completed attempt; an OOM kill names that failure in the feed.
// A retained CLOSED issue branch is represented only by its typed preflight
// complaint, never inferred back into a parked Waiting row (#179).
// A round's serial steps — each quality role, gate-1, correctness (#185,
// #187) — are one review-coloured lane span each, labelled by phase, so a red
// gate or a rejection marks its own bar. A quality lister or verify row names
// its mode and verdict, a lister's also its rule group (#204); the fixer's row
// names its commits and whatever the host discarded after it; a round's row
// names how its quality pass ended when that was not an approval. Each early
// run of a standalone gate step (#247) is a feed row naming the step, the
// fan-out it ran beside and its result; it opens no span of its own, since it
// runs inside the quality step.
// The anchor step (#217) is a pre-attempt phase like the UI check: no lane
// span, and a feed row naming how it ended and what it dropped, warning when
// the thread fell back uncondensed.
// The scenario writer (#203) is one feed row per invocation: how many
// scenarios it wrote, or how it failed. Waiting for it before the verifier is
// the round's `scenarios` step, a review span like the others. The verifier's
// scenario runner (#238) is a feed row per invocation too: the round's
// scenarios run, failed and unverified on the one that decided, warning when
// the runner itself failed.
// A `deploy` verdict (#198) is a feed line; a red one this process filed is
// also a header complaint, because the bug issue waits on a human.
// An `egress-refused` event (#202) is a warning feed line, never a complaint:
// a refusal is as likely an injection attempt as a missing allowlist entry, so
// it is the run record's to show, not the header's to escalate. A proxy's
// `egress` summary is a dim line beside the containers'.
// An idle janitor run (#205) is no issue: its events, which name a task
// instead (`EventSubject`), are feed lines tagged with that task and drive
// one header row — the task and its phase, gone once its loop finishes — and
// never reach the pool, waiting or finished tables. Its runner's
// `janitor-start`, `janitor-run` and `janitor-land` are feed lines.

import type {
  GateStepEvent,
  HeldReason,
  IssueRunEvent,
  IssueAnchorResult,
  ScenarioWriterResult,
  RecomputeWaiting,
  RunEvent,
  WaitingReason,
} from "./events.js";
import type { ContainerResources } from "./container-resources.js";
import { egressDestination } from "./egress-policy.js";
import type { RestartDueReason } from "./scheduler.js";

export type TimelineSpan = {
  readonly kind: "impl" | "review" | "adjudication";
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

export type JanitorRowState = {
  readonly task: string;
  readonly title: string;
  readonly phase: string;
  readonly phaseSince: string;
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

type LandingRequestStateBase = {
  readonly pullRequest: number;
  readonly branch: string;
  readonly title: string;
  readonly members: readonly number[];
  readonly requestedAt: string;
  readonly statusSince: string;
  readonly reason: string;
};

export type LandingRequestState = LandingRequestStateBase & (
  | {
      readonly status: "landing";
      readonly step: "merge" | "gate-2" | "push";
    }
  | { readonly status: "queued" | "deferred"; readonly step: null }
);

export type FinishedChunkState = {
  readonly pullRequest: number;
  readonly title: string;
  readonly members: readonly number[];
  readonly target: string;
  readonly ms: number;
  readonly at: string;
};

export type FeedEvent = ContainerResources & {
  readonly at: string;
  readonly issue: number | null;
  // The idle task a janitor run's line is about, in place of `issue`.
  readonly janitor?: string;
  readonly text: string;
  readonly tone: "" | "dim" | "good" | "warn" | "bad";
  readonly steps?: Readonly<Record<string, GateStepEvent>>;
};

export type UiState = {
  readonly now: string;
  readonly run: {
    readonly directory: string;
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
    // new is being admitted instead of an idle-looking pool. `deferredUntil`
    // is set while the pool still admits; null once it drains.
    readonly restart: {
      readonly detail: string;
      readonly at: string;
      readonly deferredUntil: string | null;
    } | null;
    readonly complaints: readonly {
      readonly seq: number;
      readonly severity: "warning" | "error";
      readonly text: string;
    }[];
    // The idle janitor task in its inner loop, if any.
    readonly janitor: JanitorRowState | null;
  };
  readonly pool: readonly PoolIssueState[];
  readonly waiting: readonly WaitingIssueState[];
  readonly landing: readonly LandingRequestState[];
  readonly finished: readonly FinishedIssueState[];
  readonly landedChunks: readonly FinishedChunkState[];
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

const RESTART_DUE_TEXT: Readonly<Record<RestartDueReason, string>> = {
  urgent: "urgent",
  "deferral-elapsed": "deferral elapsed",
  idle: "nothing running",
};

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

const heldText = (why: HeldReason | undefined): string => {
  switch (why) {
    case "unsettled": return "held: waiting for the issue graph to settle";
    case "joins-two-chunks": return "held: would join two chunks";
    case "frozen": return "held: its chunk's pull request carries land";
    case "unchunked-blocker": return "held: a blocker has no chunk";
    case "cycle": return "held: in a blocked-by cycle";
    case "drifted-branches": return "held: several chunk branches name its root";
    case undefined: return "held: no chunk to land on";
  }
};

export function waitingReasonText(reason: WaitingReason): string {
  switch (reason.kind) {
    case "blocked": return `blocked by ${reason.by.map((n) => `#${n}`).join(", ")}`;
    case "chunk-refresh":
      return `waiting on chunk refresh: ${reason.branch}`;
    case "no-slot": return "no free slot";
    case "held": return heldText(reason.why);
    case "ongoing": return "ongoing";
    case "label-actor":
      return reason.actor === null
        ? "excluded: 2-agent-build label actor unknown"
        : `excluded: 2-agent-build applied by @${reason.actor}`;
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
      text = event.deferredUntil !== undefined
        ? `restart requested · ${event.detail} · deferred until ${event.deferredUntil}`
        : `restart requested · ${event.detail} · draining` +
          (event.due === undefined ? "" : ` (${RESTART_DUE_TEXT[event.due]})`);
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
      text = `landing complete · ${event.durationMs}ms`;
      tone = "dim";
      break;
    case "land-request":
      text = `PR #${event.pullRequest} · ${
        event.status.kind === "landing" ? event.status.step : event.status.kind
      } · ${event.status.reason}`;
      tone = event.status.kind === "landing" ? "" : "dim";
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
      // A failed run whose commits could not be counted omits them (#188).
      const commits = event.commits === undefined
        ? ""
        : ` · ${event.commits} commit${event.commits === 1 ? "" : "s"}`;
      text = failure === null
        ? `attempt ${event.attempt} complete${commits}`
        : `attempt ${event.attempt} failed · ${failure}${commits}`;
      if (failure !== null) tone = "bad";
      break;
    }
    case "quality-pass":
      text = `round ${event.round} · quality pass${
        event.result === "completed" || event.result === "failed"
          ? `${event.result === "failed" ? " (invocation failed)" : ""} · ${event.commits.length} commit${event.commits.length === 1 ? "" : "s"}${
              qualityResidueText(event.discarded)
            }`
          : ` · ${event.result}`
      }`;
      tone = event.result === "completed" || event.result === "failed" ? "" : "bad";
      break;
    case "quality-review":
      text = `round ${event.round} · quality ${event.mode}${
        event.group === undefined ? "" : ` [${event.group}]`
      } · invocation ${event.invocation} · ${
        event.verdict ?? (event.result === "completed" ? "no verdict" : event.result)
      }`;
      tone = event.verdict === "APPROVED"
        ? "good"
        : event.verdict === null && event.result !== "completed" && event.result !== "failed"
          ? "bad"
          : "";
      break;
    case "standalone-step":
      text = `round ${event.round} · step ${event.step} (${event.mode}) · ${
        event.result === "failed"
          ? `failed exit ${event.exitCode}`
          : event.result === "timed-out" ? "timed out" : event.result
      }`;
      tone = event.result === "passed" ? "good" : event.result === "failed" ? "bad" : "warn";
      break;
    case "review-pass":
      text = `round ${event.round} · correctness pass · invocation ${event.invocation}`;
      break;
    case "adjudication":
      text = `round ${event.round} · ${event.pass} adjudication · ${event.ruling}`;
      tone = event.ruling === "UPHELD" ? "bad" : "good";
      break;
    case "resolve-attempt":
      text = `resolve attempt ${event.attempt} · ${event.end}`;
      tone = event.oomKilled === true ? "bad" : "";
      break;
    case "container":
      text = `${event.stack} container ${event.name} stopped`;
      tone = event.oomKilled === true ? "bad" : "dim";
      break;
    case "egress-refused":
      text = `${event.stack} egress ${event.enforced ? "refused" : "would refuse"} ` +
        `${egressDestination(event.host, event.port)} (${event.via})`;
      tone = "warn";
      break;
    case "egress": {
      const refused = Object.keys(event.refused).length;
      text = `${event.stack} egress proxy stopped · ${refused} destination${
        refused === 1 ? "" : "s"
      } refused`;
      tone = "dim";
      break;
    }
    case "review-round":
      text = `round ${event.round} · ${
        !event.gateOk
          ? "gate changes requested"
          : event.rejectingPass
            ? `${event.rejectingPass} changes requested`
            : "approved"
      }${
        event.quality === "APPROVED" ? "" : ` · quality ${event.quality.toLowerCase()}`
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
    case "notice":
      text = event.message;
      tone = "dim";
      break;
    case "complaint":
      text = event.message;
      tone = event.severity === "error" ? "bad" : "warn";
      break;
    case "deploy":
      text = deployText(event);
      tone = event.outcome === "green" ? "good" : event.outcome === "red" ? "bad" : "warn";
      break;
    case "janitor-start":
      text = `janitor ${event.task} started · ${event.scope.length} path(s) · ` +
        `run ${event.runsToday} of ${event.runsPerDay} today`;
      tone = "dim";
      break;
    case "janitor-run":
      text = `janitor ${event.task} ${event.outcome}` +
        (event.cause === undefined ? "" : ` · ${event.cause}`) +
        (event.pullRequest === undefined ? "" : ` · PR #${event.pullRequest}`);
      tone = event.outcome === "committed" ? "good" : event.outcome === "failed" ? "warn" : "dim";
      break;
    case "janitor-land":
      text = `janitor ${event.task} ${event.outcome}` +
        (event.reason === undefined ? "" : ` · ${event.reason}`) +
        (event.pullRequest === 0 ? "" : ` · PR #${event.pullRequest}`);
      tone = event.outcome === "parked" ? "bad" : "good";
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
    case "issue-anchor":
      text = `issue anchor · ${event.result}${
        event.dropped === 0 ? "" : ` · ${event.dropped} of ${event.comments} comments dropped`
      }`;
      tone = ANCHOR_TONE[event.result];
      break;
    case "ui-check":
      text = `UI check ${event.invocation} · ${event.result ?? "finished"}`;
      tone = "dim";
      break;
    case "scenario-writer":
      text = event.result !== "completed"
        ? `scenario writer failed: ${event.result}`
        : event.scenarios === undefined
          ? `scenario writer ${event.invocation} · format nudge`
          : `scenarios written: ${event.scenarios}`;
      tone = SCENARIO_WRITER_TONE[event.result];
      break;
    case "scenario-runner": {
      const outcomes = event.outcomes ?? [];
      const failed = outcomes.filter((o) => o.outcome === "fail").length;
      const unverified = outcomes.filter((o) => o.outcome === "unverified").length;
      const ran = `scenarios: ${outcomes.length} run, ${failed} failed, ${unverified} unverified`;
      text = event.outcomes === undefined
        ? event.result === "completed"
          ? `scenario runner ${event.invocation} · format nudge`
          : `scenario runner ${event.result}`
        : event.result === "completed" ? ran : `${ran} · runner ${event.result}`;
      tone = event.result === "wrote" || failed > 0
        ? "bad"
        : event.result === "completed" ? "dim" : "warn";
      break;
    }
    case "partition-check":
      text = `partition check ${event.invocation} · ${event.result}`;
      tone = event.result === "PARTITION" || event.result === "input-too-large"
        ? "bad"
        : "dim";
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
    ...(isJanitorEvent(event) ? { janitor: event.janitor } : {}),
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

// A fallback to the uncondensed thread is worth a look; a write parked.
const ANCHOR_TONE = {
  "below-threshold": "dim",
  "cache-hit": "dim",
  condensed: "dim",
  unparseable: "warn",
  failed: "warn",
  quota: "warn",
  credential: "warn",
  "input-too-large": "warn",
  wrote: "bad",
} as const satisfies Record<IssueAnchorResult, FeedEvent["tone"]>;

// A writer failure changes nothing for the issue; a write parks it.
const SCENARIO_WRITER_TONE = {
  completed: "dim",
  failed: "warn",
  "input-too-large": "warn",
  quota: "warn",
  credential: "warn",
  aborted: "dim",
  wrote: "bad",
} as const satisfies Record<ScenarioWriterResult, FeedEvent["tone"]>;

function finishRunningSpan(issue: MutableIssue, at: string): void {
  const last = issue.spans.at(-1);
  if (last?.to === null) {
    issue.spans[issue.spans.length - 1] = { ...last, to: at };
  }
}

const REVIEW_PHASES: ReadonlySet<string> = new Set(["quality", "gate-1", "scenarios", "review"]);

function deployText(event: Extract<RunEvent, { kind: "deploy" }>): string {
  const run = event.runId === null
    ? `no run within the deadline for ${event.sha.slice(0, 7)}`
    : `run ${event.runId} attempt ${event.attempt}`;
  const issues = event.issues.map((n) => `#${n}`).join(", ");
  const bug = event.bugIssue === null
    ? ""
    : ` · ${event.filed ? "filed" : "bug"} #${event.bugIssue}`;
  return `deploy ${event.outcome} · ${event.workflow} ${run} · ${issues}${bug}`;
}

// What the host discarded after a quality pass, in feed form (#185); "" when
// the pass left nothing to settle.
function qualityResidueText(
  residue: Extract<RunEvent, { kind: "quality-pass"; result: "completed" | "failed" }>["discarded"],
): string {
  const parts = [
    ...(residue.dirtyPaths.length === 0
      ? []
      : [`${residue.dirtyPaths.length} uncommitted path${residue.dirtyPaths.length === 1 ? "" : "s"}`]),
    ...(residue.strandedHead === null ? [] : [`off-branch HEAD ${residue.strandedHead}`]),
    ...(residue.rewoundTip === null ? [] : [`rewound tip ${residue.rewoundTip}`]),
  ];
  return parts.length === 0 ? "" : ` · discarded ${parts.join(", ")}`;
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
  } else if (event.phases.some((phase) => REVIEW_PHASES.has(phase))) {
    // One review-coloured span per serial step of the round (#185), each
    // labelled with its phase so a red gate or a rejection marks its own bar.
    issue.spans.push({
      kind: "review",
      from: event.ts,
      to: null,
      label: event.phases.join(" + "),
    });
  } else if (event.phases.includes("adjudication")) {
    issue.spans.push({
      kind: "adjudication",
      from: event.ts,
      to: null,
      label: "adjudication",
    });
  }
}

type JanitorEvent = Extract<RunEvent, { readonly janitor?: string }> & {
  readonly janitor: string;
};

const isJanitorEvent = (event: RunEvent): event is JanitorEvent =>
  "janitor" in event && event.janitor !== undefined;
const isIssueRunEvent = (event: RunEvent): event is IssueRunEvent => !isJanitorEvent(event);

// A janitor run's header row after one of its events: its loop's phase, a
// fresh cycle's setup after a HARD-ERROR, gone once the loop has finished.
function applyJanitor(row: JanitorRowState | null, event: JanitorEvent): JanitorRowState | null {
  const at = (phase: string): JanitorRowState => ({
    task: event.janitor,
    title: event.title ?? row?.title ?? "",
    phase,
    phaseSince: event.ts,
  });
  if (event.kind === "phase") return event.phases.length === 0 ? null : at(phaseLabel(event.phases));
  if (event.kind === "hard-error") return at("setup");
  return row;
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
  for (const event of events.filter(isIssueRunEvent)) {
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

function finishedChunksFrom(events: readonly RunEvent[]): readonly FinishedChunkState[] {
  return events.flatMap((event) => event.kind === "landed" &&
    event.outcome === "chunk-on-source"
    ? [{
        pullRequest: event.pullRequest,
        title: event.title,
        members: event.members,
        target: event.target,
        ms: event.durationMs,
        at: event.ts,
      }]
    : []);
}

export type ReduceRunOptions = {
  readonly runDirectory: string;
  readonly now: Date;
  readonly pidAlive: boolean;
  readonly recentFinished?: readonly FinishedIssueState[];
  readonly recentLandedChunks?: readonly FinishedChunkState[];
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
  const complaints: Array<{
    seq: number;
    severity: "warning" | "error";
    text: string;
  }> = [];
  const feed: FeedEvent[] = [];
  const parkedTerminals = new Map<
    number,
    Extract<RunEvent, { kind: "terminal" }>
  >();
  const landingRequests = new Map<number, LandingRequestState>();
  const closedBranchIssues = new Set<number>();
  let janitor: JanitorRowState | null = null;

  for (const event of events) {
    const feedEvent = feedText(event);
    if (feedEvent) feed.push(feedEvent);
    if (isJanitorEvent(event)) {
      janitor = applyJanitor(janitor, event);
      continue;
    }
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
      case "adjudication": {
        const issue = issues.get(event.issue);
        const last = issue?.spans.at(-1);
        if (issue && last?.kind === "adjudication") {
          issue.spans[issue.spans.length - 1] = {
            ...last,
            label: event.ruling,
            ...(event.ruling === "UPHELD" ? { verdict: "no" as const } : {}),
          };
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
        if (event.outcome === "chunk-on-source" || event.outcome === "chunk-parked") {
          landingRequests.delete(event.pullRequest);
        }
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
      case "land-request": {
        const previous = landingRequests.get(event.pullRequest);
        const previousStep = previous?.step ?? null;
        const nextStep = event.status.kind === "landing" ? event.status.step : null;
        const unchanged = previous !== undefined &&
          previous.status === event.status.kind &&
          previousStep === nextStep &&
          previous.reason === event.status.reason;
        const common: LandingRequestStateBase = {
          pullRequest: event.pullRequest,
          branch: event.branch,
          title: event.title,
          members: event.members,
          requestedAt: previous?.requestedAt ?? event.ts,
          statusSince: unchanged ? previous.statusSince : event.ts,
          reason: event.status.reason,
        };
        landingRequests.set(event.pullRequest, event.status.kind === "landing"
          ? { ...common, status: "landing", step: event.status.step }
          : { ...common, status: event.status.kind, step: null });
        break;
      }
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
        {
          const observed = new Set(event.landRequests);
          for (const [pullRequest, request] of landingRequests) {
            if (!observed.has(request.branch)) landingRequests.delete(pullRequest);
          }
        }
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
        complaints.push({ seq: event.seq, severity: event.severity, text: event.message });
        if (event.subject?.kind === "closed-issue-branch") {
          closedBranchIssues.add(event.subject.issue);
        }
        break;
      case "deploy":
        if (event.outcome === "red" && event.filed) {
          complaints.push({ seq: event.seq, severity: "error", text: deployText(event) });
        }
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
    // A published issue ref is normally a parked-work signal. Once a
    // structured chunk landing names that issue, the chunk row is its Finished
    // representation instead; a retained unsafe ref is reported by the
    // landing complaint and must not resurrect the closed issue under Waiting.
    const landedChunkMembers = new Set([
      ...finishedChunksFrom(events),
      ...(options.recentLandedChunks ?? []),
    ].flatMap((chunk) => chunk.members));
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
      if (
        readyIssues.has(ref.issue) || activeIssues.has(ref.issue) ||
        landedChunkMembers.has(ref.issue) || closedBranchIssues.has(ref.issue)
      ) continue;
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
  const allLandedChunks = [
    ...finishedChunksFrom(events),
    ...(options.recentLandedChunks ?? []),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const dedupedLandedChunks: FinishedChunkState[] = [];
  const seenPullRequests = new Set<number>();
  for (const item of allLandedChunks) {
    if (seenPullRequests.has(item.pullRequest)) continue;
    seenPullRequests.add(item.pullRequest);
    dedupedLandedChunks.push(item);
  }
  return {
    now: options.now.toISOString(),
    run: {
      directory: options.runDirectory,
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
      restart: restart
        ? {
          detail: restart.detail,
          at: restart.ts,
          deferredUntil: restart.deferredUntil ?? null,
        }
        : null,
      complaints,
      janitor,
    },
    pool: [...issues.values()].sort((a, b) => a.issue - b.issue),
    waiting: waitingRows.sort((a, b) => a.issue - b.issue),
    landing: [...landingRequests.values()].sort(
      (a, b) => a.pullRequest - b.pullRequest,
    ),
    finished: dedupedFinished,
    landedChunks: dedupedLandedChunks,
    eventCount: feed.length,
    events: feed.reverse().slice(0, RECENT_EVENT_LIMIT),
  };
}

export function finishedIssues(events: readonly RunEvent[]): readonly FinishedIssueState[] {
  return finishedFrom(events);
}

export function finishedChunks(events: readonly RunEvent[]): readonly FinishedChunkState[] {
  return finishedChunksFrom(events);
}
