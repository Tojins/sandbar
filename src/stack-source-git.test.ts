// The stack source against real git (#186): a repository whose own `origin`
// is itself, so `refs/remotes/origin/main` moves with a commit and a fetch and
// no network is involved. Every git call names its directory.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuiltImage, GateStackConfig, ResolvedGateStack } from "./config.js";
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
  let stackPath: string;
  let images: BuiltImage[];
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
      source: { kind: "file", path: stackPath },
      repoDir: join(repo, ".git"),
      sourceBranch: "main",
      configEnv: {},
      images,
      sandboxImage: "localhost/sandbox",
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
    stackPath = "gate/stack.json";
    images = [];
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

  it("refuses a path that is a directory in the tip", async () => {
    await land("{}");
    stackPath = "gate";
    await expect(open()).rejects.toThrow(/is a tree, not a file/);
  });

  it("keeps the last accepted stack when the tip's file is removed, complaining once without a blob", async () => {
    await land(JSON.stringify(stackWith({ TZ: "UTC" })));
    const source = await open();
    await git(repo, "rm", "-q", "gate/stack.json");
    await git(repo, "commit", "-qm", "drop");
    await git(repo, "fetch", "-q", "origin");

    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });
    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "complaint",
      message: expect.stringMatching(/^Gate stack: gate\/stack\.json at origin\/main was not accepted, so gates/),
    });
    expect(hostChecks).not.toHaveBeenCalled();
  });

  it("applies the rebuildOn rule to the first stack and to each new tip", async () => {
    images = [{ tag: "localhost/app:gate", containerfile: "Containerfile", rebuildOn: ["lock"] }];
    await land(JSON.stringify(stackWith({ TZ: "UTC" })));
    const source = await open();

    const other = stackWith({ TZ: "UTC" });
    await land(JSON.stringify({
      ...other,
      containers: other.containers.map((c) => ({ ...c, image: c.image.replace("app:gate", "app:other") })),
    }));
    expect(dbEnv((await source.current()).stack)).toEqual({ TZ: "UTC" });
    expect(events).toEqual([
      { kind: "complaint", severity: "warning", message: expect.stringMatching(/nothing\s+runs that image/) },
    ]);

    images = [{ tag: "localhost/unrun", containerfile: "Containerfile", rebuildOn: ["lock"] }];
    await expect(open()).rejects.toThrow(/nothing\s+runs that image/);
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
  describe("forHead", () => {
    // Commit `text` as gate/stack.json on a branch `issue` cut from main.
    const edit = async (text: string | null): Promise<void> => {
      await git(repo, "checkout", "-q", "-B", "issue", "main");
      if (text === null) await git(repo, "rm", "-q", "gate/stack.json");
      else await writeFile(join(repo, "gate", "stack.json"), text);
      await git(repo, "commit", "-qam", "edit");
      await git(repo, "checkout", "-q", "main");
    };
    const mounted = (): GateStackConfig => {
      const stack = stackWith({ TZ: "UTC" });
      return {
        ...stack,
        containers: stack.containers.map((c) =>
          c.name === "db" ? { ...c, mounts: [{ hostPath: "/etc", containerPath: "/x" }] } : c),
      };
    };

    beforeEach(async () => {
      await land(JSON.stringify(stackWith({ TZ: "UTC" })));
    });

    it("keeps the tip's stack for a branch that did not touch the file", async () => {
      await git(repo, "branch", "issue", "main");
      const source = await open();

      const head = await source.forHead(repo, "issue");

      expect(head.classification).toEqual({ kind: "same" });
      expect(head.stack).toBe(source.accepted().stack);
      expect(head.tipBlob).toMatch(/^[0-9a-f]{40}$/);
    });

    it("lays the branch's env over the tip's stack for an env-only edit", async () => {
      await edit(JSON.stringify(stackWith({ TZ: "Europe/Brussels" })));
      const source = await open();

      const head = await source.forHead(repo, "issue");

      expect(head.classification).toEqual({ kind: "env-only", containers: ["db"] });
      expect(dbEnv(head.stack)).toEqual({ TZ: "Europe/Brussels" });
    });

    it("keeps the tip's stack and names the difference for a mount edit", async () => {
      await edit(JSON.stringify(mounted()));
      const source = await open();

      const head = await source.forHead(repo, "issue");

      expect(head.classification).toEqual({
        kind: "non-env",
        path: "gate/stack.json",
        differences: [{ where: "container 'db'", what: "mounts" }],
      });
      expect(head.stack).toBe(source.accepted().stack);
    });

    it("reports a deleted or invalid branch file as a non-env change", async () => {
      await edit(null);
      const source = await open();
      expect((await source.forHead(repo, "issue")).classification).toEqual({
        kind: "non-env",
        path: "gate/stack.json",
        differences: [{ where: "gate/stack.json", what: "missing" }],
      });

      await edit("{ not json");
      expect((await source.forHead(repo, "issue")).classification).toMatchObject({
        kind: "non-env",
        differences: [{
          where: "gate/stack.json",
          what: expect.stringMatching(/^does not validate: gate\/stack\.json at issue: not valid JSON/),
        }],
      });
    });

    it("takes a stack change landed after the branch was cut as the tip's, not the branch's", async () => {
      await git(repo, "branch", "issue", "main");
      await land(JSON.stringify(mounted()));
      const source = await open();

      const head = await source.forHead(repo, "issue");

      expect(head.classification).toEqual({ kind: "same" });
      expect(head.stack.containers[0]!.mounts).toHaveLength(1);
    });

    it("is `same` for a branch carrying the very edit that has since landed", async () => {
      await edit(JSON.stringify(mounted()));
      await land(JSON.stringify(mounted()));
      const source = await open();

      expect((await source.forHead(repo, "issue")).classification).toEqual({ kind: "same" });
    });
  });
});

describe("openStackSource over an inline stack", () => {
  it("applies the rebuildOn rule to the inline stack", async () => {
    await expect(openStackSource({
      source: { kind: "inline", stack: { containers: [], steps: [] }, attachments: { env: {}, mounts: [] } },
      repoDir: "/nonexistent",
      sourceBranch: "main",
      configEnv: {},
      images: [{ tag: "localhost/unrun", containerfile: "Containerfile", rebuildOn: ["lock"] }],
      sandboxImage: "localhost/sandbox",
      hostChecks: async () => undefined,
      onEvent: () => undefined,
    })).rejects.toThrow(/nothing\s+runs that image/);
  });

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
      images: [],
      sandboxImage: "localhost/sandbox",
      hostChecks: async () => {
        throw new Error("not asked");
      },
      onEvent: () => undefined,
    });
    await expect(source.current()).resolves.toBe(inline);
    expect(source.accepted()).toBe(inline);
    expect(source.path).toBeNull();
    // No branch reaches an inline stack.
    await expect(source.forHead("/nonexistent", "HEAD")).resolves.toEqual({
      stack: inline.stack,
      attachments: inline.attachments,
      classification: { kind: "same" },
      tipBlob: null,
    });
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
