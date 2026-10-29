import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_JANITOR_LEDGER,
  janitorLedgerPath,
  ledgerWithHold,
  ledgerWithStart,
  ledgerWithVisit,
  readJanitorLedger,
  writeJanitorLedger,
} from "./janitor-ledger.js";

describe("the janitor ledger (#205)", () => {
  let stateDir: string;
  const notices: string[] = [];
  const onNotice = async (message: string): Promise<void> => {
    notices.push(message);
  };

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "sandbar-janitor-ledger-"));
    notices.length = 0;
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("reads an absent file as empty, silently", async () => {
    expect(await readJanitorLedger(stateDir, "tidy", onNotice)).toEqual(EMPTY_JANITOR_LEDGER);
    expect(notices).toEqual([]);
  });

  it("round-trips a written ledger and leaves no temporary file", async () => {
    const ledger = ledgerWithHold(
      ledgerWithVisit(ledgerWithStart(EMPTY_JANITOR_LEDGER, new Date("2026-10-28T10:00:00Z")), ["a.ts"], new Date("2026-10-28T10:05:00Z"), new Set(["a.ts"])),
      { kind: "conflict", key: "b..s" },
    );
    await writeJanitorLedger(stateDir, "tidy", ledger);
    expect(await readJanitorLedger(stateDir, "tidy", onNotice)).toEqual(ledger);
    expect(await readdir(join(stateDir, "janitor"))).toEqual(["tidy.json"]);
  });

  it.each([
    ["corrupt JSON", "{ not json"],
    ["another version", JSON.stringify({ version: 2, starts: [], visits: {} })],
    ["a malformed hold", JSON.stringify({ version: 1, starts: [], visits: {}, hold: { kind: "nap", key: "k" } })],
    ["non-string starts", JSON.stringify({ version: 1, starts: [3], visits: {} })],
  ])("reads %s as empty, with a notice", async (_, body) => {
    await mkdir(join(stateDir, "janitor"), { recursive: true });
    await writeFile(janitorLedgerPath(stateDir, "tidy"), body);
    expect(await readJanitorLedger(stateDir, "tidy", onNotice)).toEqual(EMPTY_JANITOR_LEDGER);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("starting task 'tidy' afresh");
  });

  it("keeps eight days of starts", () => {
    const old = { ...EMPTY_JANITOR_LEDGER, starts: ["2026-10-19T09:00:00.000Z", "2026-10-21T09:00:00.000Z"] };
    expect(ledgerWithStart(old, new Date("2026-10-28T10:00:00.000Z")).starts)
      .toEqual(["2026-10-21T09:00:00.000Z", "2026-10-28T10:00:00.000Z"]);
  });

  it("forgets visits to units that are no longer candidates", () => {
    const before = { ...EMPTY_JANITOR_LEDGER, visits: { "gone.ts": "2026-10-01T00:00:00.000Z", "kept.ts": "2026-10-02T00:00:00.000Z" } };
    expect(ledgerWithVisit(before, ["new.ts"], new Date("2026-10-28T00:00:00.000Z"), new Set(["kept.ts", "new.ts"])).visits)
      .toEqual({ "kept.ts": "2026-10-02T00:00:00.000Z", "new.ts": "2026-10-28T00:00:00.000Z" });
  });

  it("sets and clears a hold", () => {
    const held = ledgerWithHold(EMPTY_JANITOR_LEDGER, { kind: "source-missing", key: "k" });
    expect(held.hold).toEqual({ kind: "source-missing", key: "k" });
    expect(ledgerWithHold(held, null)).toEqual(EMPTY_JANITOR_LEDGER);
  });
});
