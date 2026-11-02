import { describe, expect, it } from "vitest";

import type { GateDomain } from "./config.js";
import type { Scenario } from "./scenario-parser.js";
import { finalVerdict, scenarioDomains } from "./scenario-records.js";

describe("finalVerdict", () => {
  it.each([
    ["a last PASS", { status: "pass", head: "h", round: 2 }, "pass"],
    ["a retired scenario", { status: "retired" }, "fail-overruled"],
    ["a last UNVERIFIED", { status: "unverified", head: "h", round: 1 }, "unverified"],
    ["a failure whose rerun went unverified", { status: "fail", head: "h", round: 1 }, "unverified"],
    ["a scenario that never had a runner verdict", undefined, "unverified"],
  ] as const)("calls %s %s", (_name, entry, verdict) => {
    expect(finalVerdict(entry)).toBe(verdict);
  });
});

describe("scenarioDomains", () => {
  const domain = (name: string, ...paths: string[]): GateDomain =>
    ({ name, description: name, paths, sanity: [] });
  const domains = [
    domain("ui", "ui/**"),
    domain("gate", "src/gate-*.ts"),
    domain("db", "src/db/**", "!src/db/fixtures/**"),
    domain("docs", "docs/*.md"),
  ];
  const files = ["ui/app.tsx", "src/gate-run.ts", "src/db/copy.ts", "src/db/fixtures/a.sql", "README.md"];
  const at = (...area: string[]): Scenario =>
    ({ id: "S1", title: "t", needs: ["cli"], area, given: ["g"], when: ["w"], then: ["t"] });

  it.each([
    ["a file a domain's glob matches", ["src/gate-run.ts"], ["gate"]],
    ["a file that is not in the tree yet", ["src/gate-new.ts"], ["gate"]],
    ["a directory, by the files under it", ["src/"], ["gate", "db"]],
    ["a directory a glob names past it", ["ui"], ["ui"]],
    ["only an excluded file", ["src/db/fixtures/a.sql"], []],
    ["no domain's paths", ["README.md"], []],
    ["several entries, each domain once", ["src/gate-run.ts", "src/gate-new.ts", "docs/a.md"], ["gate", "docs"]],
  ])("reaches %s", (_name, area, expected) => {
    expect(scenarioDomains(at(...area), domains, files)).toEqual(expected);
  });
});
