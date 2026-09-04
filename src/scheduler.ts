// Continuous issue-pool state machine (#87): the one owner of admission,
// active slots, completed and pending terminals, planner-visible ongoing
// membership, silent-noop retries, once-per-run starts and the landing
// counters. I/O stays in run.ts; each method here is one atomic transition and
// `decideSchedulerAction` is the whole control decision over a snapshot of it.
//
// TWO UNITS, AND THEY ARE NOT THE SAME.
//
//   - ONGOING (planner-visible): from admission until the issue lands or parks.
//     A DONE issue awaiting its landing is ongoing. The planner excludes every
//     ongoing issue from every recompute, so nothing is re-picked while sandbar
//     still has business with it, and no label is touched while it is ongoing.
//   - SLOT (execution): held only while the inner loop runs. A DONE issue
//     releases its slot the moment `runInnerLoop` returns and waits for its
//     landing without occupying one. Concurrency is `width` slots.
//
// Everything below turns on keeping those two apart. `#ongoing` is the first,
// `#active` the second; `#started` is broader than both and never shrinks —
// AN ISSUE STARTS ONCE PER RUN, no exceptions, which is the first of the four
// loop countermeasures the issue rebuilt in place of the cycle-scoped wedge
// detectors (an identical-plan fingerprint needs a second cycle to compare
// against, and there are no cycles). The one thing that looks like a second
// start, a silent-noop re-admission via `retry`, is handled INSIDE the ongoing
// unit: the issue never left `#ongoing`, `admit` serves it ahead of every
// candidate, and it costs no start.
//
// THE DECISION, IN PRECEDENCE ORDER — each line is a rule, and the reason it
// sits where it does:
//
//   1. recompute — a completion arrived while the plan was being built, so the
//      snapshot describes a pool that no longer exists. Cheapest to rebuild.
//   2. quota    — a provider closed for the run (#109). No new starts, ever;
//      pending terminals land first, because committed-but-unlanded work is
//      the expensive thing in this system; running work drains to its
//      terminal (under a two-vendor config an issue routed to the other
//      provider may genuinely finish); then exit 4. Outranks the backstop and
//      the relaunch because a relaunch would only rediscover the closed window.
//   3. stuck    — `terminalBackstop` consecutive terminals with no landing.
//      Same shape as quota: land what is pending, drain what is active, exit
//      2. Evaluated on EVERY observation, not at quiescence — a deep queue
//      refills every freed slot and is never quiescent until the candidates
//      run out, which is the one case the backstop exists for.
//   4. relaunch — quiescent, at least one landing in this process, and work
//      remains. Before `admit`, or the pool starts the issue and the moment is
//      gone. The "landing in this process" clause is what stops a launch-time
//      spin: a fresh process with a full plan and nothing running is the start
//      of a run, not a relaunch point.
//   5. budget   — quiescent with no starts left and nothing to retry. After
//      relaunch, because budgets are per process and reset across relaunches
//      by design (exit-conditions.ts's header owns the argument).
//   6. admit    — a free slot and something to put in it: a retry first, then
//      a candidate while starts remain. Refill BEFORE landing, so a slot does
//      not idle through gate-2; `next` says which of `land`/`wait` follows.
//   7. land     — terminals are pending, or a human's `land` request is the
//      only work and nothing is running to grow the chunk under it.
//   8. wait     — slots are busy and nothing else applies: block for the next
//      freed slot.
//   9. plan-empty — nothing active, nothing ongoing, nothing to admit, nothing
//      to land.
//
// WHAT `recordLandingOutcome` COUNTS. `landed` is landings in the sense
// exit-conditions.ts's header defines — source-branch merges, chunks landed on
// the source branch, AND DONE branches landed on their chunk branch. The
// backstop and the relaunch both read it, and both would be wrong on a
// review-lane host otherwise: there, work leaves the pool only onto chunk
// branches, and a counter that ignored those would exit stuck after six
// successful landings. Whether the source branch moved — the image-rebuild
// question — is a different fact and run.ts keeps it separately.
//
// `waitForFreedSlot` settles through one extra microtask on purpose: the
// `.then` that pushes into `#completed` runs after the raced promise resolves,
// and reading `#completed` on the same tick would miss the event that woke
// us. The settled events move to `#pendingTerminals` here and nowhere else, so
// "in `#active`", "completed but unobserved" and "observed, awaiting a landing"
// are three disjoint places and an issue is in at most one of them.

export type SettledIssue<T, R> =
  | { readonly status: "fulfilled"; readonly issue: T; readonly value: R }
  | { readonly status: "rejected"; readonly issue: T; readonly reason: unknown };

export type Admission<T> = { readonly issues: readonly T[]; readonly newStarts: number };

export type SchedulerExit = "plan-empty" | "relaunch" | "quota" | "budget" | "stuck";
export type SchedulerAction =
  | { readonly kind: "recompute" }
  | { readonly kind: "admit"; readonly next: "land" | "wait" }
  | { readonly kind: "land" }
  | { readonly kind: "wait" }
  | { readonly kind: "drain" }
  | { readonly kind: "exit"; readonly reason: SchedulerExit };

export type SchedulerSnapshot = {
  readonly active: number;
  readonly ongoing: number;
  readonly hasCompleted: boolean;
  readonly hasPendingTerminals: boolean;
  readonly hasCandidates: boolean;
  readonly hasRetries: boolean;
  readonly hasLandRequests: boolean;
  readonly hasCapacity: boolean;
  readonly budgetRemaining: number;
  readonly landings: number;
  readonly terminalsSinceLanding: number;
  readonly terminalBackstop: number;
  readonly quotaClosed: boolean;
};

// The complete control decision for one scheduler observation. Keeping the
// precedence here makes run.ts an executor: it performs I/O, refreshes this
// snapshot, and obeys one explicit action rather than rediscovering lifecycle
// rules at several points in its outer loop.
export function decideSchedulerAction(state: SchedulerSnapshot): SchedulerAction {
  const quiescent = state.active === 0 && state.ongoing === 0;
  if (state.hasCompleted) return { kind: "recompute" };
  if (
    state.quotaClosed &&
    (state.hasPendingTerminals || (state.hasLandRequests && state.active === 0))
  ) {
    return { kind: "land" };
  }
  if (state.quotaClosed) {
    return state.active > 0 ? { kind: "drain" } : { kind: "exit", reason: "quota" };
  }
  if (state.terminalsSinceLanding >= state.terminalBackstop) {
    if (state.hasPendingTerminals) return { kind: "land" };
    return state.active > 0 ? { kind: "drain" } : { kind: "exit", reason: "stuck" };
  }
  if (quiescent && state.landings > 0 && (state.hasCandidates || state.hasLandRequests)) {
    return { kind: "exit", reason: "relaunch" };
  }
  if (quiescent && state.budgetRemaining === 0 && !state.hasRetries) {
    return { kind: "exit", reason: "budget" };
  }
  if (
    state.hasCapacity &&
    (state.hasRetries || (state.budgetRemaining > 0 && state.hasCandidates))
  ) {
    return { kind: "admit", next: state.hasPendingTerminals ? "land" : "wait" };
  }
  if (state.hasPendingTerminals || (state.hasLandRequests && state.active === 0)) {
    return { kind: "land" };
  }
  if (state.active > 0) return { kind: "wait" };
  if (state.hasLandRequests) return { kind: "land" };
  return { kind: "exit", reason: "plan-empty" };
}

export class ContinuousPool<T, R> {
  readonly #active = new Map<string, Promise<SettledIssue<T, R>>>();
  readonly #completed: SettledIssue<T, R>[] = [];
  readonly #pendingTerminals: SettledIssue<T, R>[] = [];
  readonly #ongoing = new Map<string, T>();
  readonly #started = new Set<string>();
  readonly #retries: T[] = [];
  #landings = 0;
  #terminalsSinceLanding = 0;

  constructor(readonly width: number, readonly idOf: (issue: T) => string) {
    if (!Number.isInteger(width) || width < 1) {
      throw new RangeError(`pool width must be a positive integer (got ${String(width)})`);
    }
  }

  get activeCount(): number { return this.#active.size; }
  get ongoingCount(): number { return this.#ongoing.size; }
  get hasCompleted(): boolean { return this.#completed.length > 0; }
  get hasPendingTerminals(): boolean { return this.#pendingTerminals.length > 0; }
  get hasRetries(): boolean { return this.#retries.length > 0; }
  get isQuiescent(): boolean { return this.#active.size === 0 && this.#ongoing.size === 0; }
  get landings(): number { return this.#landings; }
  get terminalsSinceLanding(): number { return this.#terminalsSinceLanding; }
  ongoingIssues(): readonly T[] { return [...this.#ongoing.values()]; }
  startedIds(): ReadonlySet<string> { return new Set(this.#started); }
  hasUnstarted(candidates: readonly T[]): boolean {
    return candidates.some((issue) => !this.#started.has(this.idOf(issue)));
  }

  admit(candidates: readonly T[], startBudget: number, closed = false): Admission<T> {
    if (closed) return { issues: [], newStarts: 0 };
    const available = Math.max(0, this.width - this.#active.size);
    const issues = this.#retries.splice(0, available);
    let newStarts = 0;
    for (const issue of candidates) {
      if (issues.length >= available || newStarts >= startBudget) break;
      const id = this.idOf(issue);
      if (this.#started.has(id)) continue;
      this.#started.add(id);
      this.#ongoing.set(id, issue);
      issues.push(issue);
      newStarts += 1;
    }
    return { issues, newStarts };
  }

  start(issue: T, work: Promise<R>): void {
    const id = this.idOf(issue);
    if (this.#active.has(id)) throw new RangeError(`issue ${id} already holds a slot`);
    if (!this.#ongoing.has(id)) this.#ongoing.set(id, issue);
    const task = work
      .then<SettledIssue<T, R>>((value) => ({ status: "fulfilled", issue, value }))
      .catch<SettledIssue<T, R>>((reason: unknown) => ({
        status: "rejected", issue, reason,
      }))
      .then((event) => { this.#completed.push(event); return event; });
    this.#active.set(id, task);
  }

  async waitForFreedSlot(): Promise<readonly SettledIssue<T, R>[]> {
    if (this.#completed.length === 0 && this.#active.size > 0) {
      await Promise.race(this.#active.values());
      await Promise.resolve();
    }
    const settled = this.#completed.splice(0);
    for (const event of settled) this.#active.delete(this.idOf(event.issue));
    this.#pendingTerminals.push(...settled);
    return settled;
  }

  takeLandingBatch(): readonly SettledIssue<T, R>[] {
    return this.#pendingTerminals.splice(0).sort(
      (a, b) => Number(this.idOf(a.issue)) - Number(this.idOf(b.issue)),
    );
  }

  finish(issue: T): void { this.#ongoing.delete(this.idOf(issue)); }
  retry(issue: T): void {
    const id = this.idOf(issue);
    if (!this.#ongoing.has(id)) throw new RangeError(`issue ${id} is not ongoing`);
    if (!this.#retries.some((queued) => this.idOf(queued) === id)) this.#retries.push(issue);
  }

  recordLandingOutcome(terminals: number, landed: number): void {
    this.#landings += landed;
    this.#terminalsSinceLanding = landed > 0
      ? 0
      : this.#terminalsSinceLanding + terminals;
  }
}
