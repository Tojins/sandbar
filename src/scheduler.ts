// Pure state for the continuous issue pool (#87).
//
// `ongoing` and `running` deliberately differ. An issue becomes ongoing when
// first admitted and remains so until it lands or parks; `running` is only the
// subset currently holding an execution slot. DONE issues wait in `done`
// without consuming a slot. The orchestrator recomputes a full plan whenever
// `settle` releases one.

export type PoolState = {
  readonly width: number;
  readonly started: ReadonlySet<string>;
  readonly ongoing: ReadonlySet<string>;
  readonly running: ReadonlySet<string>;
  readonly done: ReadonlySet<string>;
};

export function newPoolState(width: number): PoolState {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError(`pool width must be a positive integer (got ${String(width)})`);
  }
  return {
    width,
    started: new Set(),
    ongoing: new Set(),
    running: new Set(),
    done: new Set(),
  };
}

export function freeSlots(state: PoolState): number {
  return state.width - state.running.size;
}

// Admits candidates in planner order. A previously-started issue is never
// admitted again, even after it leaves `ongoing`.
export function admit(state: PoolState, candidates: readonly string[]): PoolState {
  const started = new Set(state.started);
  const ongoing = new Set(state.ongoing);
  const running = new Set(state.running);
  for (const id of candidates) {
    if (running.size >= state.width) break;
    if (started.has(id)) continue;
    started.add(id);
    ongoing.add(id);
    running.add(id);
  }
  return { ...state, started, ongoing, running };
}

export function settle(
  state: PoolState,
  id: string,
  outcome: "done" | "terminal" | "rejected",
): PoolState {
  if (!state.running.has(id)) {
    throw new RangeError(`issue ${id} is not holding a slot`);
  }
  const running = new Set(state.running);
  const ongoing = new Set(state.ongoing);
  const done = new Set(state.done);
  running.delete(id);
  if (outcome === "done") done.add(id);
  else ongoing.delete(id);
  return { ...state, running, ongoing, done };
}

// Snapshot the landing batch. Numeric issue order makes reporting stable even
// when inner loops finish in a different order.
export function landingBatch(state: PoolState): readonly string[] {
  return [...state.done].sort((a, b) => Number(a) - Number(b));
}

export function finishLanding(
  state: PoolState,
  landedOrParked: readonly string[],
): PoolState {
  const ongoing = new Set(state.ongoing);
  const done = new Set(state.done);
  for (const id of landedOrParked) {
    done.delete(id);
    ongoing.delete(id);
  }
  return { ...state, ongoing, done };
}
