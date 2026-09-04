// Continuous issue-pool state machine (#87).
//
// Sole owner of admission, active promises, completed terminals waiting for a
// recompute, planner-visible ongoing membership, retries, and once-per-run
// starts. I/O stays in run.ts; each method is one atomic transition.

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
