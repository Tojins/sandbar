// Daemon issue-pool state machine (#87, #133): the one owner of admission,
// active slots, completed and pending terminals, planner-visible ongoing
// membership, silent-noop retries, once-per-run starts and the stuck
// counter. I/O stays in run.ts; each method here is one atomic transition and
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
// `#started` prevents duplicate admission while an issue is in flight. A
// terminal clears it but puts the id in `#untilPoll`, so a still-labelled
// HARD-ERROR retries on the next interval rather than hot-looping in the same
// recompute chain. `beginPoll` releases those marks. A silent-noop retry stays
// inside the ongoing unit and remains first in the next admission.
//
// THE DECISION, IN PRECEDENCE ORDER — each line is a rule, and the reason it
// sits where it does:
//
//   1. recompute — a completion arrived while the plan was being built, so the
//      snapshot describes a pool that no longer exists. Cheapest to rebuild.
//   2. quota    — a provider closed for the process (#109). No new starts;
//      pending terminals land first, because committed-but-unlanded work is
//      the expensive thing in this system; running work drains to its
//      terminal (under a two-vendor config an issue routed to the other
//      provider may genuinely finish); then exit 4. Outranks the backstop.
//   3. stuck    — `noProgressBackstop` consecutive no-progress observations.
//      Same shape as quota: land what is pending, drain what is active, exit
//      2. Evaluated on EVERY observation, not at quiescence — a deep queue
//      refills every freed slot and is never quiescent until the candidates
//      run out, which is the one case the backstop exists for.
//   4. admit    — a free slot and something to put in it: a retry first, then
//      a candidate. Refill BEFORE landing, so a slot does
//      not idle through gate-2; `next` says which of `land`/`wait` follows.
//   5. land     — terminals are pending, or a human's `land` request is the
//      only work and nothing is running to grow the chunk under it.
//   6. wait     — wait on one cancellable race between a freed slot and the
//      poll timer. This is also the empty-plan action: the daemon stays alive.
//
// WHAT `recordLandingOutcome` COUNTS. `landed` is landings in the sense
// exit-conditions.ts's header defines — source-branch merges, chunks landed on
// the source branch, AND DONE branches landed on their chunk branch. The
// backstop reads it and would be wrong on a review-lane host otherwise: there,
// work leaves the pool only onto chunk
// branches, and a counter that ignored those would exit stuck after six
// successful landings. Whether the source branch moved — the image-rebuild
// question — is a different fact and run.ts keeps it separately. An unchanged
// requested landing is suppressed after its pass until another trigger wakes
// the scheduler; it advances no terminal counter.
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

export type PoolWake = "slot-freed" | "poll";

export type SchedulerExit = "quota" | "stuck";
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
  readonly noProgressSinceLanding: number;
  readonly noProgressBackstop: number;
  readonly quotaClosed: boolean;
};

// The complete control decision for one scheduler observation. Keeping the
// precedence here makes run.ts an executor: it performs I/O, refreshes this
// snapshot, and obeys one explicit action rather than rediscovering lifecycle
// rules at several points in its outer loop.
export function decideSchedulerAction(state: SchedulerSnapshot): SchedulerAction {
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
  if (state.noProgressSinceLanding >= state.noProgressBackstop) {
    if (state.hasPendingTerminals) return { kind: "land" };
    return state.active > 0 ? { kind: "drain" } : { kind: "exit", reason: "stuck" };
  }
  if (
    state.hasCapacity &&
    (state.hasRetries || state.hasCandidates)
  ) {
    return { kind: "admit", next: state.hasPendingTerminals ? "land" : "wait" };
  }
  if (state.hasPendingTerminals || (state.hasLandRequests && state.active === 0)) {
    return { kind: "land" };
  }
  if (state.active > 0) return { kind: "wait" };
  if (state.hasLandRequests) return { kind: "land" };
  return { kind: "wait" };
}

export class ContinuousPool<T, R> {
  readonly #active = new Map<string, Promise<SettledIssue<T, R>>>();
  readonly #completed: SettledIssue<T, R>[] = [];
  readonly #pendingTerminals: SettledIssue<T, R>[] = [];
  readonly #ongoing = new Map<string, T>();
  readonly #started = new Set<string>();
  readonly #untilPoll = new Set<string>();
  readonly #retries: T[] = [];
  #noProgressSinceLanding = 0;

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
  get noProgressSinceLanding(): number { return this.#noProgressSinceLanding; }
  ongoingIssues(): readonly T[] { return [...this.#ongoing.values()]; }
  startedIds(): ReadonlySet<string> { return new Set(this.#started); }
  hasUnstarted(candidates: readonly T[]): boolean {
    return candidates.some((issue) => {
      const id = this.idOf(issue);
      return !this.#started.has(id) && !this.#untilPoll.has(id);
    });
  }

  beginPoll(): void { this.#untilPoll.clear(); }

  admit(candidates: readonly T[], closed = false): readonly T[] {
    if (closed) return [];
    const available = Math.max(0, this.width - this.#active.size);
    const issues = this.#retries.splice(0, available);
    for (const issue of candidates) {
      if (issues.length >= available) break;
      const id = this.idOf(issue);
      if (this.#started.has(id) || this.#untilPoll.has(id)) continue;
      this.#started.add(id);
      this.#ongoing.set(id, issue);
      issues.push(issue);
    }
    return issues;
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

  // One cancellable wake owns the daemon's wait (#133). The timer is armed
  // afresh after every recompute and cleared by whichever source wins. A slot
  // completion observed in the winner's microtask is named `slot-freed`, so
  // two sources in one tick still produce one wake and one recompute.
  async waitForWake(pollIntervalMs: number): Promise<PoolWake> {
    if (this.#active.size >= this.width) {
      await Promise.race(this.#active.values());
      await Promise.resolve();
      await this.waitForFreedSlot();
      return "slot-freed";
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = new Promise<PoolWake>((resolve) => {
      timer = setTimeout(() => resolve("poll"), pollIntervalMs);
    });
    const slot = this.#active.size === 0
      ? null
      : Promise.race(this.#active.values()).then((): PoolWake => "slot-freed");
    const wake = await (slot === null ? poll : Promise.race([slot, poll]));
    if (timer !== undefined) clearTimeout(timer);
    await Promise.resolve();
    if (this.#completed.length > 0) {
      await this.waitForFreedSlot();
      return "slot-freed";
    }
    return wake;
  }

  takeLandingBatch(): readonly SettledIssue<T, R>[] {
    return this.#pendingTerminals.splice(0).sort(
      (a, b) => Number(this.idOf(a.issue)) - Number(this.idOf(b.issue)),
    );
  }

  finishTerminal(issue: T): void {
    const id = this.idOf(issue);
    this.#ongoing.delete(id);
    this.#started.delete(id);
    this.#untilPoll.add(id);
  }

  finishRejected(issue: T): void {
    this.#ongoing.delete(this.idOf(issue));
  }
  retry(issue: T): void {
    const id = this.idOf(issue);
    if (!this.#ongoing.has(id)) throw new RangeError(`issue ${id} is not ongoing`);
    if (!this.#retries.some((queued) => this.idOf(queued) === id)) this.#retries.push(issue);
  }

  recordLandingOutcome(
    terminals: number,
    landed: number,
  ): void {
    this.#noProgressSinceLanding = landed > 0
      ? 0
      : this.#noProgressSinceLanding + terminals;
  }
}
