import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RepoLabel,
  type SyncedLabel,
  declaredLabels,
  labelSyncCommand,
  planLabelSync,
  renderLabelSync,
  syncLabels,
} from "./label-sync.js";

const PROTOCOL = ["ready-for-agent", "waiting", "auto-land", "needs-review", "land", "needs-human"];
const handoff = { handoff: "needs-human" };
const host = { name: "ready-for-human", description: "A human picks this up", color: "d93f0b" };

describe("declaredLabels", () => {
  it("declares every protocol label with a description and colour, then the host's", () => {
    const declared = declaredLabels(handoff, [host]);
    expect(declared.map((l) => l.name)).toEqual([...PROTOCOL, "ready-for-human"]);
    for (const label of declared) {
      expect(label.description).not.toBe("");
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(label.from).toBeNull();
    }
  });

  it("follows the configured handoff label", () => {
    expect(declaredLabels({ handoff: "blocked" }, []).map((l) => l.name)).toContain("blocked");
  });

  it("lets config override a protocol label's description and declare its rename", () => {
    const declared = declaredLabels(handoff, [
      { name: "Needs-Human", description: "Ours to look at", from: "needs-info" },
    ]);
    const canonical = declaredLabels(handoff, []).find((l) => l.name === "needs-human")!;
    expect(declared.find((l) => l.name === "needs-human")).toEqual({
      name: "needs-human",
      description: "Ours to look at",
      color: canonical.color,
      from: "needs-info",
    });
    expect(declared).toHaveLength(PROTOCOL.length);
  });

  it.each([
    [[{ name: "agent-queued", color: "ededed" }], /`agent-queued` is not a sandbar protocol label/],
    [[{ name: "agent-queued", description: "Queued" }], /needs both a description and a color/],
    [[host, { ...host, name: "Ready-For-Human" }], /declares `Ready-For-Human` twice/],
    [[{ ...host, from: "land" }], /names `land` both as a label and as a rename's `from`/],
    [[{ ...host, from: "x" }, { ...host, name: "y", from: "X" }], /names `X`/],
  ])("refuses %o", (declarations, message) => {
    expect(() => declaredLabels(handoff, declarations)).toThrow(message);
  });
});

const synced = (name: string, over: Partial<SyncedLabel> = {}): SyncedLabel => ({
  name, description: `${name} described`, color: "aaaaaa", from: null, ...over,
});
const inRepo = (label: SyncedLabel): RepoLabel => ({
  name: label.name, description: label.description, color: label.color,
});

describe("planLabelSync", () => {
  it("creates what is missing and leaves what matches, case-insensitively", () => {
    const [a, b] = [synced("a"), synced("b")];
    const plan = planLabelSync([a, b], [{ name: "A", description: a.description, color: "AAAAAA" }]);
    expect(plan).toEqual({ steps: [{ kind: "create", label: b }], undeclared: [] });
  });

  it("updates a label whose description or colour differs, naming what changed", () => {
    const a = synced("a");
    expect(planLabelSync([a], [{ ...inRepo(a), description: "old" }]).steps).toEqual([
      { kind: "update", label: a, changed: ["description"] },
    ]);
    expect(planLabelSync([a], [{ ...inRepo(a), description: "old", color: "000000" }]).steps).toEqual([
      { kind: "update", label: a, changed: ["description", "color"] },
    ]);
  });

  it("renames `from` when only it exists, and is done once the new name does", () => {
    const a = synced("a", { from: "old-a" });
    expect(planLabelSync([a], [{ ...inRepo(a), name: "Old-A" }])).toEqual({
      steps: [{ kind: "rename", label: a, from: "Old-A" }],
      undeclared: [],
    });
    expect(planLabelSync([a], [inRepo(a)]).steps).toEqual([]);
    expect(planLabelSync([a], []).steps).toEqual([{ kind: "create", label: a }]);
  });

  it("refuses a rename whose source and target both exist", () => {
    const a = synced("a", { from: "old-a" });
    expect(() => planLabelSync([a], [inRepo(a), { ...inRepo(a), name: "old-a" }])).toThrow(
      /both `old-a` and `a`.*nothing was changed/s,
    );
  });

  it("reports labels outside the declared set without a step for them", () => {
    const a = synced("a");
    expect(planLabelSync([a], [inRepo(a), { name: "bug", description: "", color: "d73a4a" }])).toEqual({
      steps: [],
      undeclared: ["bug"],
    });
  });
});

describe("labelSyncCommand", () => {
  it("creates and updates with `gh label create --force`, renames with `gh label edit --name`", () => {
    const a = synced("a", { from: "old-a" });
    const fields = ["--description", "a described", "--color", "aaaaaa"];
    expect(labelSyncCommand({ kind: "create", label: a }, "o/r")).toEqual(
      ["label", "create", "a", "--repo", "o/r", "--force", ...fields],
    );
    expect(labelSyncCommand({ kind: "update", label: a, changed: ["color"] }, "o/r")).toEqual(
      ["label", "create", "a", "--repo", "o/r", "--force", ...fields],
    );
    expect(labelSyncCommand({ kind: "rename", label: a, from: "old-a" }, "o/r")).toEqual(
      ["label", "edit", "old-a", "--repo", "o/r", "--name", "a", ...fields],
    );
  });
});

describe("renderLabelSync", () => {
  it("says what changed and what it kept, or that nothing changed", () => {
    expect(renderLabelSync({ steps: [], undeclared: ["bug"] })).toEqual([
      "labels: nothing to change",
      "undeclared, kept: bug",
    ]);
    expect(renderLabelSync({
      steps: [
        { kind: "create", label: synced("a") },
        { kind: "update", label: synced("b"), changed: ["description"] },
        { kind: "rename", label: synced("c"), from: "old-c" },
      ],
      undeclared: [],
    })).toEqual(["created a", "updated b (description)", "renamed old-c -> c"]);
  });
});

// A `gh` on PATH that keeps a repository's labels and issues in a JSON file.
// Issues hold label IDS, as GitHub's do, so a rename that keeps them is
// visible and a delete-and-recreate would not be. Each call holds a lock
// directory, as the server serializes writes: the sync's steps run at once.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_GH_STATE;
const lock = file + ".lock";
for (;;) {
  try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== "EEXIST") throw e; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const find = (name) => state.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
let failure = null;
state.calls.push(argv);
if (argv[0] === "label" && argv[1] === "list") {
  process.stdout.write(JSON.stringify(state.labels.map(({ name, description, color }) => ({ name, description, color }))));
} else if (argv[0] === "label" && argv[1] === "create" && argv.includes("--force")) {
  const label = find(argv[2]);
  const fields = { description: flag("--description"), color: flag("--color") };
  if (label) Object.assign(label, fields);
  else state.labels.push({ id: Math.max(0, ...state.labels.map((l) => l.id)) + 1, name: argv[2], ...fields });
} else if (argv[0] === "label" && argv[1] === "edit") {
  const label = find(argv[2]);
  if (!label) failure = "no label " + argv[2];
  else if (find(flag("--name"))) failure = "already exists";
  else Object.assign(label, { name: flag("--name"), description: flag("--description"), color: flag("--color") });
} else {
  failure = "unexpected gh " + argv.join(" ");
}
fs.writeFileSync(file, JSON.stringify(state));
fs.rmdirSync(lock);
if (failure !== null) { process.stderr.write(failure); process.exitCode = 1; }
`;

type FakeRepo = {
  labels: { id: number; name: string; description: string; color: string }[];
  issues: { number: number; labelIds: number[] }[];
  calls: string[][];
};

describe("syncLabels against a repository", () => {
  let dir: string;
  let stateFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "label-sync-"));
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), 0o755);
    stateFile = join(dir, "state.json");
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("FAKE_GH_STATE", stateFile);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (repo: Omit<FakeRepo, "calls">): void =>
    writeFileSync(stateFile, JSON.stringify({ ...repo, calls: [] }));
  const read = (): FakeRepo => JSON.parse(readFileSync(stateFile, "utf8")) as FakeRepo;
  const writes = (): string[][] => read().calls.filter((argv) => argv[1] !== "list");
  const sync = (declarations: Parameters<typeof declaredLabels>[1]) =>
    syncLabels({
      repo: { owner: "o", name: "r" },
      cwd: dir,
      declared: declaredLabels(handoff, declarations),
    });

  it("creates every missing label once; a second run changes nothing", async () => {
    seed({ labels: [{ id: 1, name: "land", description: "x", color: "000000" }], issues: [] });
    const first = await sync([host]);
    expect(first.steps.map((s) => [s.kind, s.label.name])).toEqual(
      [...PROTOCOL, "ready-for-human"].map((n) => [n === "land" ? "update" : "create", n]),
    );
    expect(read().labels.map((l) => l.name).sort()).toEqual([...PROTOCOL, "ready-for-human"].sort());

    seed({ ...read() });
    expect(renderLabelSync(await sync([host]))).toEqual(["labels: nothing to change"]);
    expect(writes()).toEqual([]);
  });

  it("a changed description in config updates that label and nothing else", async () => {
    seed({ labels: [], issues: [] });
    await sync([host]);
    seed({ ...read() });
    const plan = await sync([{ ...host, description: "Triaged for a human" }]);
    expect(renderLabelSync(plan)).toEqual(["updated ready-for-human (description)"]);
    expect(writes()).toEqual([labelSyncCommand(plan.steps[0]!, "o/r")]);
    expect(read().labels.find((l) => l.name === "ready-for-human")?.description).toBe("Triaged for a human");
  });

  it("a declared rename moves the label and the issues keep it", async () => {
    seed({
      labels: [{ id: 7, name: "needs-info", description: "old", color: "000000" }],
      issues: [{ number: 12, labelIds: [7] }],
    });
    const plan = await sync([{ name: "needs-human", from: "needs-info" }]);
    expect(renderLabelSync(plan)).toContain("renamed needs-info -> needs-human");
    const after = read();
    expect(after.labels.find((l) => l.id === 7)?.name).toBe("needs-human");
    expect(after.labels.some((l) => l.name === "needs-info")).toBe(false);
    expect(after.issues).toEqual([{ number: 12, labelIds: [7] }]);

    seed({ ...after });
    expect(renderLabelSync(await sync([{ name: "needs-human", from: "needs-info" }]))).toEqual([
      "labels: nothing to change",
    ]);
  });

  it("lists a label the repo has and config does not, and keeps it", async () => {
    seed({ labels: [{ id: 1, name: "bug", description: "", color: "d73a4a" }], issues: [] });
    const plan = await sync([]);
    expect(renderLabelSync(plan)).toContain("undeclared, kept: bug");
    expect(read().labels.find((l) => l.name === "bug")).toEqual(
      { id: 1, name: "bug", description: "", color: "d73a4a" },
    );
    expect(writes().some((argv) => argv.includes("bug"))).toBe(false);
  });
});
