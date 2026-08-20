// What a Ctrl-C actually tears down (#35).
//
// Asserted in a REAL child process, and it has to be: the bug was an
// interaction between two signal listeners — cleanup.ts's, which starts the
// async `runCleanup()` and returns at its first await, and agent-sandbox.ts's,
// which node ran next and which ended in a synchronous `process.exit(1)`,
// killing the registry mid-action. In-process there is nothing to observe (the
// exit would take the vitest worker with it), and a test that only counts
// listeners passes just as happily against a handler that still exits — the
// same trap lock.test.ts documents for the lock takeover.
//
// The child imports the modules' SOURCE, not dist/: a test pinning these two
// must not be able to pass against a stale compile. Plain `node` strips the
// types, but unlike lock.ts these modules have relative `./x.js` imports that
// resolve to `x.ts` on disk, which node does not rewrite — hence the tiny
// resolve hook the child preloads. Requires a node new enough to do both
// unflagged, which the suite already assumes elsewhere.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

let dir: string;
const kill: Array<() => void> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbar-sigint-"));
});
afterAll(async () => {
  for (const k of kill) k();
  await rm(dir, { recursive: true, force: true });
});

const RESOLVE_HOOK = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      const asTs = nextResolve(specifier.slice(0, -3) + ".ts", context);
      if (existsSync(fileURLToPath(asTs.url))) return asTs;
    }
    return nextResolve(specifier, context);
  },
});
`;

// Registration order is run()'s: the shared traps first, the sandbox teardown
// after — which is what puts cleanup.ts's listener ahead of any the sandbox
// installs, and is the arrangement the bug needed.
const childSource = (markerPath: string) => `
import { appendFileSync } from "node:fs";
import { installCleanupTraps, onCleanup } from ${JSON.stringify(join(SRC_DIR, "cleanup.ts"))};
import { registerShutdown } from ${JSON.stringify(join(SRC_DIR, "agent-sandbox.ts"))};

const note = (line) => appendFileSync(${JSON.stringify(markerPath)}, line + "\\n");

installCleanupTraps();
// Async on purpose, and slow on purpose: every real action in this registry is
// one (stopStack, the merger worktree removal, the run log's finalize, the
// lock release), and an action that resolves in the same tick cannot show the
// truncation this test is about.
onCleanup(async () => {
  await new Promise((r) => setTimeout(r, 250));
  note("registry-action-finished");
});
registerShutdown(() => note("sandbox-teardown"));

console.log("ready");
setInterval(() => {}, 1000);
`;

type ChildRun = { code: number | null; signal: string | null; lines: string[] };

async function sigintChild(): Promise<ChildRun> {
  const marker = join(dir, "marker.txt");
  const hook = join(dir, "resolve-hook.mjs");
  const script = join(dir, "child.mts");
  await writeFile(marker, "");
  await writeFile(hook, RESOLVE_HOOK);
  await writeFile(script, childSource(marker));

  const child = spawn(process.execPath, ["--import", hook, script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  kill.push(() => child.kill("SIGKILL"));

  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
        if (out.includes("ready")) child.kill("SIGINT");
      });
      child.stderr.on("data", (c: Buffer) => (err += c.toString()));
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (!out.includes("ready")) {
          reject(new Error(`child never started. stderr:\n${err}`));
        } else {
          resolve({ code, signal });
        }
      });
    },
  );

  const { code, signal } = await exited;
  const lines = (await readFile(marker, "utf8")).split("\n").filter(Boolean);
  return { code, signal, lines };
}

describe("SIGINT during a run", () => {
  let run: ChildRun;

  beforeAll(async () => {
    run = await sigintChild();
  }, 30_000);

  // The whole issue: with agent-sandbox's own handler in place this action was
  // still awaiting its timer when `process.exit(1)` fired, and every action
  // behind it in the LIFO order — the pods, the merger worktree, the run log's
  // final write, the lock release — never ran at all.
  it("lets an async cleanup action finish", () => {
    expect(run.lines).toContain("registry-action-finished");
  });

  it("still tears the sandbox down, through the shared registry", () => {
    expect(run.lines).toContain("sandbox-teardown");
    // LIFO, so the sandbox teardown (registered last) leads. Asserting the
    // order is what shows it ran as a registry action rather than from a
    // handler of its own racing alongside one.
    expect(run.lines.indexOf("sandbox-teardown")).toBeLessThan(
      run.lines.indexOf("registry-action-finished"),
    );
  });

  it("runs each teardown once, not once per path that reaches it", () => {
    // `runCleanup` fans them out, and then `runCleanup`'s own `process.exit`
    // fires the `exit` hook, which fans them out again. Undrained, the operator
    // gets the worktree-preserved notice twice.
    expect(run.lines.filter((l) => l === "sandbox-teardown")).toHaveLength(1);
  });

  it("exits 130, the code cleanup.ts chose for SIGINT", () => {
    // The old handler's `process.exit(1)` won this race, so the run reported a
    // generic failure rather than an interrupt.
    expect(run.signal).toBeNull();
    expect(run.code).toBe(130);
  });
});
