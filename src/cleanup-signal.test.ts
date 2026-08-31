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

// The existence probe comes BEFORE the delegation, not after it: node's own
// resolver finalizes a relative specifier by checking the file is there, so a
// missing `.ts` sibling leaves `nextResolve` as an ERR_MODULE_NOT_FOUND rather
// than as a URL to be probed. Probing the answer would therefore make the
// fallback unreachable, and the whole file would fail as `child never started`
// naming a `.ts` path nobody wrote — the exact miss the fallback is for. It is
// not hypothetical for long: this hook sees CJS `require` as well as `import`,
// so one dependency doing `require("./polyfills.js")` reaches it.
const RESOLVE_HOOK = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      const asTs = specifier.slice(0, -3) + ".ts";
      if (existsSync(fileURLToPath(new URL(asTs, context.parentURL)))) {
        return nextResolve(asTs, context);
      }
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
// Exercises the hook's fallback, which nothing in the module graph reaches
// today (every relative import under src/ has a .ts sibling) and which would
// otherwise sit here unrun until the day a dependency needed it.
import "./no-ts-sibling.js";
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

// `name` keeps each case's marker and script distinct — they share `dir`, and a
// second case writing over the first's marker would read back the first's
// lines and pass on them.
async function sigintChild(
  name: string,
  source: (markerPath: string) => string,
): Promise<ChildRun> {
  const marker = join(dir, `${name}-marker.txt`);
  const hook = join(dir, "resolve-hook.mjs");
  const script = join(dir, `${name}-child.mjs`);
  await writeFile(marker, "");
  await writeFile(hook, RESOLVE_HOOK);
  await writeFile(join(dir, "no-ts-sibling.js"), "module.exports = {};\n");
  await writeFile(script, source(marker));

  const child = spawn(process.execPath, ["--import", hook, script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  kill.push(() => child.kill("SIGKILL"));

  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      let out = "";
      let err = "";
      let sent = false;
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
        // Once only. cleanup.ts's trap is a `process.once`, so a second SIGINT
        // arriving while the first is still awaiting the registry would find
        // no listener and default-terminate the child — failing the exit-code
        // assertion below as a flake rather than as the regression.
        if (!sent && out.includes("ready")) {
          sent = true;
          child.kill("SIGINT");
        }
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
    run = await sigintChild("sandbox", childSource);
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
    // LIFO, so the sandbox teardown (registered last) leads. The ordering is
    // a property of the registry, not the thing under test — under the bug it
    // held too, and what fails below is the comparison against a -1, the async
    // action never having got to write its line.
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

// What a Ctrl-C tears down when the teardowns are DISPOSABLES (#55).
//
// Same process boundary as above, and for a sharper version of the same
// reason: the failure this collapsing can introduce is invisible in-process. A
// shared registry entry that drops an action, or drains its Set forwards
// instead of backwards, still returns normally and still leaves the registry
// looking swept — the only observable is which teardowns actually ran, in
// which order, in a process that then died on the signal.
const disposableChildSource = (markerPath: string) => `
import { appendFileSync } from "node:fs";
import {
  installCleanupTraps,
  onCleanup,
  registerDisposable,
} from ${JSON.stringify(join(SRC_DIR, "cleanup.ts"))};

const note = (line) => appendFileSync(${JSON.stringify(markerPath)}, line + "\\n");
const slow = (line) => async () => {
  // Async and slow, like every real disposable (stopStack, the merger worktree
  // removal): a same-tick action cannot show a truncated drain.
  await new Promise((r) => setTimeout(r, 100));
  note(line);
};

installCleanupTraps();
// A plain entry, registered before any disposable — which is where run.ts
// registers all four of its own, ahead of the cycle loop that creates the
// disposables. LIFO therefore puts it LAST, exactly as it was before the
// collapsing, and that is the property the shared entry must not disturb.
onCleanup(slow("plain-first"));

registerDisposable(slow("d0"));
registerDisposable(slow("d1"));
const dropD2 = registerDisposable(slow("d2-MUST-NOT-RUN"));
registerDisposable(async () => {
  await new Promise((r) => setTimeout(r, 100));
  note("d3");
  // The mid-drain window. A signal does not abort an in-flight startStack, it
  // starts the drain alongside it, so an action registered while the drain is
  // running still has to be picked up — the property \`while (size > 0)\` exists
  // for, and the one a refactor to \`for (const x of set)\` would delete in
  // silence.
  registerDisposable(slow("d4-mid-drain"));
});
// The unregister half: a teardown that has already run drops itself, and must
// then not run again off the registry.
dropD2();

console.log("ready");
setInterval(() => {}, 1000);
`;

describe("SIGINT with disposable teardowns", () => {
  let run: ChildRun;

  beforeAll(async () => {
    run = await sigintChild("disposables", disposableChildSource);
  }, 30_000);

  it("runs every disposable, behind the one shared registry entry", () => {
    expect(run.lines).toContain("d0");
    expect(run.lines).toContain("d1");
    expect(run.lines).toContain("d3");
  });

  it("does not run a disposable that was unregistered", () => {
    expect(run.lines).not.toContain("d2-MUST-NOT-RUN");
  });

  it("picks up a disposable registered DURING the drain", () => {
    expect(run.lines).toContain("d4-mid-drain");
  });

  it("drains reverse-registration, and after everything registered later", () => {
    // d3, then d4 (registered mid-drain, so newest by the time the drain looks
    // again), then d1, d0 — and the plain entry last, because LIFO reaches the
    // shared entry at the position of the FIRST disposable registration, which
    // is still ahead of it. Asserted as the whole sequence rather than as
    // `toContain`s: a Set iterated forwards would run d0 first and tear down
    // the merger worktree while the merger stack still bind-mounts it, and
    // every individual membership check above would still pass.
    expect(run.lines).toEqual([
      "d3",
      "d4-mid-drain",
      "d1",
      "d0",
      "plain-first",
    ]);
  });

  it("exits 130, the code cleanup.ts chose for SIGINT", () => {
    expect(run.signal).toBeNull();
    expect(run.code).toBe(130);
  });
});
