// The stack source against real git (#186): a repository whose own `origin`
// is itself, so `refs/remotes/origin/main` moves with a commit and a fetch and
// no network is involved. Every git call names its directory.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GateStackConfig, ResolvedGateStack } from "./config.js";
import { SandbarError } from "./errors.js";
import type { EventInput } from "./events.js";
import { openStackSource, readStackFrom, stackSpecToken } from "./stack-source.js";

const exec = promisify(execFile);
const git = (repo: string, ...args: string[]) =>
  exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
  });

const stackWith = (env: Record<string, string>): GateStackConfig => ({
  containers: [
    { name: "db", image: "docker.io/library/mariadb:10.11", lifecycle: "issue", env },
    { name: "app", image: "localhost/app:gate", mountWorktree: "/w", hold: true },
  ],
  steps: [{ name: "test", in: "app", command: ["npm", "test"] }],
});

describe("openStackSource over a stack file", () => {
  let repo: string;
  let events: EventInput[];
  let hostChecks: ReturnType<typeof vi.fn<(stack: ResolvedGateStack) => Promise<void>>>;

  // Commit `text` as gate/stack.json and move origin/main to it.
  const land = async (text: string): Promise<void> => {
    await mkdir(join(repo, "gate"), { recursive: true });
    await writeFile(join(repo, "gate", "stack.json"), text);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "stack");
    await git(repo, "fetch", "-q", "origin");
  };
  const open = () =>
    openStackSource({
      source: { kind: "file", path: "gate/stack.json" },
      repoDir: join(repo, ".git"),
      sourceBranch: "main",
      configEnv: {},
      hostChecks,
      onEvent: (event) => {
        events.push(event);
      },
    });
  const dbEnv = (stack: ResolvedGateStack) => stack.containers[0]!.env;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-stack-source-"));
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "remote", "add", "origin", repo);
    events = [];
    hostChecks = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reads origin/<sourceBranch>:<path>, with the file's other keys ignored", async () => {
    await land(JSON.stringify({ comment: "outdoor's", ...stackWith({ TZ: "UTC" }) }));
    // The working tree moving on must not matter: only the fetched tip does.
    await writeFile(join(repo, "gate", "stack.json"), "not json");

    const source = await open();

    expect(dbEnv(source.accepted().stack)).toEqual({ TZ: "UTC" });
    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });
    // Startup's host checks are preflight's; nothing new was accepted.
    expect(hostChecks).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("refuses to open on a tip without the file, or with an invalid one", async () => {
    await land("{}");
    await git(repo, "rm", "-q", "gate/stack.json");
    await git(repo, "commit", "-qm", "drop");
    await git(repo, "fetch", "-q", "origin");
    await expect(open()).rejects.toThrow(
      new SandbarError("gate/stack.json at origin/main: no such file."),
    );

    await land(JSON.stringify({ containers: [], steps: [] }));
    await expect(open()).rejects.toThrow(
      /^gate\/stack\.json at origin\/main: containers must not be empty/,
    );
  });

  it("accepts a new tip once it passes the host checks, and announces it", async () => {
    await land(JSON.stringify(stackWith({ TZ: "UTC" })));
    const source = await open();

    await land(JSON.stringify(stackWith({ TZ: "Europe/Brussels" })));
    const current = await source.current();

    expect(dbEnv(current.stack)).toEqual({ TZ: "Europe/Brussels" });
    expect(source.accepted()).toBe(current);
    expect(hostChecks).toHaveBeenCalledExactlyOnceWith(current.stack);
    expect(events).toEqual([
      { kind: "notice", message: expect.stringMatching(/^Gate stack: accepted gate\/stack\.json at origin\/main \(blob [0-9a-f]{40}\)/) },
    ]);
    // An unchanged tip is not checked again.
    await source.current();
    expect(hostChecks).toHaveBeenCalledOnce();
  });

  it("keeps the last accepted stack for an invalid tip and complains once per blob", async () => {
    await land(JSON.stringify(stackWith({ TZ: "UTC" })));
    const source = await open();

    await land("{ not json");
    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });
    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });
    await land("[]");
    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });

    expect(events.map((e) => e.kind)).toEqual(["complaint", "complaint"]);
    expect(events[0]).toMatchObject({
      severity: "warning",
      message: expect.stringContaining("gate/stack.json at origin/main: not valid JSON"),
    });
    expect(hostChecks).not.toHaveBeenCalled();
  });

  it("does not cache a host-check failure, so the same tip is accepted once it passes", async () => {
    await land(JSON.stringify(stackWith({ TZ: "UTC" })));
    const source = await open();
    await land(JSON.stringify(stackWith({ TZ: "Europe/Brussels" })));
    hostChecks.mockRejectedValueOnce(new SandbarError("1 gate-stack image(s) … missing"));

    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });
    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "Europe/Brussels" });
    expect(events.map((e) => e.kind)).toEqual(["complaint", "notice"]);
    expect(events[0]).toMatchObject({ message: expect.stringContaining("image(s) … missing") });
  });

  it("propagates a host check that fails for any other reason", async () => {
    await land(JSON.stringify(stackWith({ TZ: "UTC" })));
    const source = await open();
    await land(JSON.stringify(stackWith({ TZ: "Europe/Brussels" })));
    hostChecks.mockRejectedValueOnce(new TypeError("a bug"));

    await expect(source.current()).rejects.toThrow(TypeError);
  });
});

describe("openStackSource over an inline stack", () => {
  it("hands back the config's stack without reading anything", async () => {
    const inline = {
      kind: "inline" as const,
      stack: { containers: [], steps: [] },
      attachments: { env: {}, mounts: [] },
    };
    const source = await openStackSource({
      source: inline,
      repoDir: "/nonexistent",
      sourceBranch: "main",
      configEnv: {},
      hostChecks: async () => {
        throw new Error("not asked");
      },
      onEvent: () => undefined,
    });
    await expect(source.current()).resolves.toBe(inline);
    expect(source.accepted()).toBe(inline);
  });
});

describe("readStackFrom", () => {
  it("reads the file under the given root, labelled with its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-stack-disk-"));
    try {
      const source = { kind: "file" as const, path: "gate/stack.json" };
      await expect(readStackFrom(source, root, {})).rejects.toThrow(
        `${join(root, "gate/stack.json")}: no such file`,
      );
      await mkdir(join(root, "gate"));
      await writeFile(join(root, "gate", "stack.json"), JSON.stringify(stackWith({ A: "1" })));
      const { stack } = await readStackFrom(source, root, {});
      expect(stack.containers[0]!.env).toEqual({ A: "1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("stackSpecToken", () => {
  const spec = (env: Record<string, string>): ResolvedGateStack => ({
    containers: [{
      name: "db", image: "i", lifecycle: "issue", env, args: [], mounts: [],
      mountWorktree: null, servesWorktree: false, inSandbox: false, hold: false,
      readiness: null, readinessTimeoutMs: 1, postReadyCommands: [],
    }],
    steps: [],
  });

  it("differs for an env change and not for reordered keys", () => {
    expect(stackSpecToken(spec({ A: "1" }))).not.toBe(stackSpecToken(spec({ A: "2" })));
    expect(stackSpecToken(spec({ A: "1", B: "2" }))).toBe(stackSpecToken(spec({ B: "2", A: "1" })));
  });
});
