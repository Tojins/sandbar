// Cleanup registry + signal traps.
//
// Cleanup actions are executed once, in LIFO order, on SIGINT / SIGTERM /
// uncaughtException / unhandledRejection. This registry is the explicit #35
// exception to the ordinary catch rule: each independent action failure is
// reported with its cause and the drain continues, because partial cleanup is
// always better than none and there is no original failure for this loop to
// rethrow.
//
// That holds only while this handler OWNS THE EXIT (#35): `runCleanup()` is
// async, and a `process.exit` from any later signal listener kills the
// registry mid-flight. So: register teardowns HERE. Nothing else in the
// process may install a SIGINT/SIGTERM handler, and nothing else may call
// `process.exit` on a signal.
//
// `onCleanup` NEVER FORGETS AN ACTION — that is what lets a stack register its
// teardown *before* the first pod exists, so a signal in the bringup window
// still sweeps whatever got created. The cost is that a caller inside a loop
// grows the registry without limit; that is what `registerDisposable` below is
// for (#55).

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
// It is an ORDINARY REGISTRY ENTRY THAT CAN BE TAKEN BACK OUT, and that is the
// whole implementation: the registration window, the LIFO position and the
// mid-drain behaviour are `onCleanup`'s, unchanged, because this IS `onCleanup`
// plus a removal.
//
// #55 sketched the other shape — a module-level Set behind one shared
// `onCleanup` entry, draining reverse-insertion — arguing that a collapsed
// entry keeps teardown ORDER unchanged, since every plain entry is registered
// before the cycle loop starts and so sits ahead of all of them either way.
// That premise is false, and the counterexample is the one place where this
// order is load-bearing: agent-sandbox.ts registers its shared
// `onCleanup(runTeardowns)` LAZILY, when the first sandbox container is
// created. That is inside the cycle loop and after `startStack`'s own
// registration — the two are launched by one `Promise.allSettled`, and
// `startStack` registers synchronously while `createSandbox` must await
// `podman run` first. A collapsed entry sits at the position of the FIRST
// disposable, i.e. ahead of that one, so the LIFO drain would reach the
// agent-sandbox teardown BEFORE the sandbox stack's — removing the netns anchor
// out from under its joiners, which is exactly the inversion
// `sandbox-stack.ts`'s `stop` says leaks the whole chain. Removing an entry in
// place cannot invert anything: the array is the order, and it stays the order
// no matter who registers between two disposables.
//
// Deliberately NOT `onCleanup` itself returning an unregister token. Every early
// registration in this codebase leans on "the registry never forgets", and
// handing that token to callers who never asked for it weakens the property for
// all of them. `registerDisposable` names the narrower contract — register
// before the resource exists, withdraw when the teardown's own latch flips —
// and only its callers hold the token.
//
// NOT a home for agent-sandbox.ts's `registerShutdown` (#55). That Set is also
// drained from `process.on("exit")`, where nothing can be awaited, which is why
// its teardowns are synchronous — these are async. Serving both would mean a
// dual-mode registry built to accommodate one caller whose constraint is a
// property of node's `exit` event rather than of cleanup.
export function registerDisposable(action: CleanupAction): () => void {
  actions.push(action);
  return () => {
    // `indexOf` rather than an index held from registration time: `runCleanup`
    // pops from the end while this runs, so a recorded position is only still
    // right if nothing has drained. A miss is an ordinary path, not an error —
    // the drain takes each action out of the array before awaiting it, so a
    // teardown that withdraws itself from inside its own body finds itself
    // already gone.
    const at = actions.indexOf(action);
    if (at >= 0) actions.splice(at, 1);
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
      console.error("Cleanup action failed", { cause: err });
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
