// Cleanup registry + signal traps.
//
// Cleanup actions are executed once, in LIFO order, on SIGINT / SIGTERM /
// uncaughtException / unhandledRejection. Each action is awaited and its
// failures are logged but never block the next action — partial cleanup is
// always better than none.

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
