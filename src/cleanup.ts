// Cleanup registry + signal traps.
//
// Cleanup actions are executed once, in LIFO order, on SIGINT / SIGTERM /
// uncaughtException / unhandledRejection. Each action is awaited and its
// failures are logged but never block the next action — partial cleanup is
// always better than none.
//
// That "on SIGINT / SIGTERM" is a claim about the whole registry, and it holds
// only while this handler OWNS THE EXIT (#35). `runCleanup()` is async and
// returns to the signal handler at its first await, node runs signal listeners
// in registration order, and a `process.exit` from any later listener kills the
// registry mid-flight — everything after the action it was awaiting is simply
// skipped. agent-sandbox.ts installed exactly such a handler until #35, so
// every Ctrl-C lost the per-issue pods and networks, the merger worktree, the
// run log's terminal write and the lock release, while the containers that
// handler owned were torn down neatly enough to make it look like cleanup had
// run. So: register teardowns HERE. Nothing else in the process may install a
// SIGINT/SIGTERM handler, and nothing else may call `process.exit` on a signal.
//
// `onCleanup` NEVER FORGETS AN ACTION, and that is load-bearing rather than
// incidental: it is what lets a stack register its teardown *before* the first
// pod exists, so a signal anywhere in the bringup window still sweeps whatever
// got created. The cost is that a caller inside a loop — one per issue, per
// cycle, per retry — grows the registry without limit. That is what
// `registerDisposable` below is for (#55): the same never-forgets registration
// window, over a resource that ends.

type CleanupAction = () => Promise<void> | void;

const actions: CleanupAction[] = [];
let installed = false;
let running = false;

export function onCleanup(action: CleanupAction): void {
  actions.push(action);
}

// ---------------------------------------------------------------------------
// Disposables (#55)
// ---------------------------------------------------------------------------

// Register a teardown for a resource that is created in a LOOP — a gate stack,
// a sandbox stack, the merger worktree, a `sandbar gate` invocation. All of
// them share the shape `onCleanup` cannot express: they must be registered
// before their resource exists, and they must be *forgotten* once it is gone,
// or the registry accumulates one dead closure per issue, per cycle, per
// HARD-ERROR retry, for the life of the process. The returned function drops
// the action; call it from inside the teardown, right after its own
// idempotence latch flips.
//
// One `onCleanup` entry stands behind the whole Set, registered lazily, so the
// registry's own length is unchanged no matter how many resources pass through.
//
// NOT a home for agent-sandbox.ts's `registerShutdown` (#55). That Set is also
// drained from `process.on("exit")`, where nothing can be awaited, which is why
// its teardowns are synchronous — these are async. Serving both would mean a
// dual-mode registry built to accommodate one caller whose constraint is a
// property of node's `exit` event rather than of cleanup.
const disposables = new Set<CleanupAction>();
let disposablesRegistered = false;
// Set only once the shared entry's own drain has RUN TO COMPLETION, so a
// registration arriving during the drain still lands in the Set below and is
// still picked up. See `drainDisposables`.
let disposablesDrained = false;

// Drained take-last, while non-empty — deliberately the Set analogue of
// `runCleanup`'s `while (actions.length > 0) actions.pop()`, for two reasons
// that are not free choices:
//
//   1. A signal does not abort an in-flight `startStack`; it starts the drain
//      alongside it. An action registered DURING the drain therefore has to be
//      picked up, exactly as a late `onCleanup` is — which a `for (const x of
//      set)` would silently stop doing.
//   2. Take-LAST keeps teardown order what it was before this Set existed.
//      `onCleanup` drains LIFO, and the shared entry sits at the position of
//      the FIRST disposable registration; iterating the Set in insertion order
//      would run its members forwards from there — removing the merger
//      worktree while the merger gate stack's containers still bind-mount it.
//      Reverse-insertion order within the Set preserves the relative order of
//      every member exactly, and every non-disposable entry is registered
//      before the cycle loop starts, so it is ahead of all of them either way.
async function drainDisposables(): Promise<void> {
  while (disposables.size > 0) {
    let action: CleanupAction | undefined;
    for (const a of disposables) action = a;
    if (action === undefined) break;
    disposables.delete(action);
    try {
      await action();
    } catch (err) {
      console.error("Cleanup action failed:", err);
    }
  }
  disposablesDrained = true;
}

export function registerDisposable(action: CleanupAction): () => void {
  // Past the shared entry: fall back to a plain `onCleanup`, which is caught if
  // `runCleanup`'s own loop is still running and dropped if it is not —
  // precisely what happens to a late `onCleanup` today. NOT run immediately:
  // these are registered before their resource exists, so an immediate call
  // tears down nothing and then never tears down the pod that appears a second
  // later.
  if (disposablesDrained) {
    onCleanup(action);
    // Nothing to withdraw — `onCleanup` does not forget, by design.
    return () => {};
  }
  if (!disposablesRegistered) {
    disposablesRegistered = true;
    onCleanup(drainDisposables);
  }
  disposables.add(action);
  return () => {
    disposables.delete(action);
  };
}

export async function runCleanup(): Promise<void> {
  if (running) return;
  running = true;
  while (actions.length > 0) {
    const action = actions.pop();
    if (!action) break;
    try {
      await action();
    } catch (err) {
      console.error("Cleanup action failed:", err);
    }
  }
}

export function installCleanupTraps(): void {
  if (installed) return;
  installed = true;

  const handler = (signal: NodeJS.Signals) => {
    console.error(`\nReceived ${signal}, cleaning up…`);
    runCleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };

  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    runCleanup().finally(() => process.exit(1));
  });
  process.once("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    runCleanup().finally(() => process.exit(1));
  });
}
