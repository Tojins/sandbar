// The idle janitor's visit ledger (#205): one host-local file per task at
// `<stateDir>/janitor/<task>.json`, holding the task's recent run starts, the
// last visit of each scope unit and the hold the task is under, if any.
//
// A cache, never an authority. Losing it costs repeat visits and a reset day
// count, so unreadable or wrong-version content reads as an empty ledger
// with a `notice`. A write goes to a temporary file that is then renamed into
// place, so a reader never sees half of one. `runsPerDay` (`janitor-plan.ts`)
// reads `starts`; the scope picker reads `visits`.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isErrno } from "./errors.js";

const LEDGER_VERSION = 1;

// Run starts older than this are dropped on write: the day count needs today's.
const STARTS_KEPT_MS = 8 * 24 * 60 * 60 * 1000;

// Why a task waits, and the key that releases it once it no longer matches
// (`janitorHoldKey`, `janitor-plan.ts`).
export type JanitorHold = {
  readonly kind: "conflict" | "source-missing" | "clone-preserved";
  readonly key: string;
};

export type JanitorLedger = {
  readonly version: typeof LEDGER_VERSION;
  // ISO instants of run starts, oldest first.
  readonly starts: readonly string[];
  // Scope unit (a file or directory path) -> ISO instant of its last visit.
  readonly visits: Readonly<Record<string, string>>;
  readonly hold?: JanitorHold;
};

export const EMPTY_JANITOR_LEDGER: JanitorLedger = { version: LEDGER_VERSION, starts: [], visits: {} };

export const janitorLedgerPath = (stateDir: string, task: string): string =>
  join(stateDir, "janitor", `${task}.json`);

const isLedger = (value: unknown): value is JanitorLedger => {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  const visits = o["visits"];
  const hold = o["hold"] as Record<string, unknown> | undefined;
  return o["version"] === LEDGER_VERSION &&
    Array.isArray(o["starts"]) && o["starts"].every((s) => typeof s === "string") &&
    typeof visits === "object" && visits !== null && !Array.isArray(visits) &&
    Object.values(visits).every((v) => typeof v === "string") &&
    (hold === undefined || (
      typeof hold === "object" && hold !== null &&
      ["conflict", "source-missing", "clone-preserved"].includes(hold["kind"] as string) &&
      typeof hold["key"] === "string"
    ));
};

export async function readJanitorLedger(
  stateDir: string,
  task: string,
  onNotice: (message: string) => Promise<void>,
): Promise<JanitorLedger> {
  const path = janitorLedgerPath(stateDir, task);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return EMPTY_JANITOR_LEDGER;
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    value = null;
  }
  if (isLedger(value)) return value;
  await onNotice(`Janitor ledger ${path} is unreadable or of another version; starting task '${task}' afresh.`);
  return EMPTY_JANITOR_LEDGER;
}

export async function writeJanitorLedger(
  stateDir: string,
  task: string,
  ledger: JanitorLedger,
): Promise<void> {
  const path = janitorLedgerPath(stateDir, task);
  await mkdir(join(stateDir, "janitor"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(temporary, path);
}

// The ledger after a run starts at `at`, keeping the last eight days' starts.
export function ledgerWithStart(ledger: JanitorLedger, at: Date): JanitorLedger {
  const keptFrom = at.getTime() - STARTS_KEPT_MS;
  return {
    ...ledger,
    starts: [...ledger.starts.filter((s) => Date.parse(s) >= keptFrom), at.toISOString()],
  };
}

// The ledger after `scope` was visited at `at`. A unit that is no longer
// among `candidates` is forgotten.
export function ledgerWithVisit(
  ledger: JanitorLedger,
  scope: readonly string[],
  at: Date,
  candidates: ReadonlySet<string>,
): JanitorLedger {
  const visits: Record<string, string> = {};
  for (const [unit, last] of Object.entries(ledger.visits)) {
    if (candidates.has(unit)) visits[unit] = last;
  }
  for (const unit of scope) visits[unit] = at.toISOString();
  return { ...ledger, visits };
}

export function ledgerWithHold(ledger: JanitorLedger, hold: JanitorHold | null): JanitorLedger {
  const { hold: _previous, ...rest } = ledger;
  return hold === null ? rest : { ...rest, hold };
}
