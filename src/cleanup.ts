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

type CleanupAction = () => Promise<void> | void;

const actions: CleanupAction[] = [];
let installed = false;
let running = false;

export function onCleanup(action: CleanupAction): void {
  actions.push(action);
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
