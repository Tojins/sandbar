// The enforcer for runtime.ts's one rule: A PODMAN ARGV NEVER CARRIES AN
// ENVIRONMENT VALUE (#154).
//
// It lives here rather than beside any one builder because it is a claim about
// ALL of them at once, and the four are in three modules. The argument the
// issue rests on is that no wrapper anywhere can leak a credential it never
// saw — node's `execFile` error message is `Command failed: <argv joined>`, and
// the inner loop records that as a `hard-error` event `reason` the UI then
// serves (#132). That argument holds only while every builder obeys, so the
// invariant is asserted over the set, not per builder.
//
// The table alone would be a weaker claim than the rule needs, because a fifth
// builder is only covered by it if its author also adds it to `BUILDERS` — and
// the author of a `-e KEY=VALUE` regression is exactly who would not. So the
// scan below carries the other half, the way error-swallow-ratchet.test.ts does
// for its own rule: runtime.ts is the ONE production module that writes any
// podman environment flag, so any other module that spells one fails here.
// Between them, a new builder either hands its variables to `withRuntimeEnv` —
// which cannot put one in an argv — or it announces itself.
//
// Each case supplies credential-SHAPED values, so the second half of the check
// — no value appears anywhere in the argv — is testing what the issue reported
// rather than a placeholder.
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sandboxRunArgs } from "./agent-sandbox.js";
import { resolveGateStack } from "./config.js";
import { SandbarError } from "./errors.js";
import { containerRunArgs, stepExecArgs } from "./gate-stack.js";
import { buildResolveRunArgv } from "./merger.js";
import {
  formatEnvFile,
  withRuntimeEnv,
  type RuntimeInvocation,
} from "./runtime.js";

const SECRET = "sk-ant-oat01-thisisthewholetoken";
const PAT = "ghp_thisisthewholepat";

// Through the validation boundary rather than a hand-built literal: a second
// copy of `ResolvedStackContainer`'s fields is one more fixture to repair every
// time the type gains one, and gate-stack.test.ts already keeps the one this
// suite would be duplicating.
const gateContainer = (
  env: Readonly<Record<string, string>>,
): ReturnType<typeof resolveGateStack>["containers"][number] =>
  resolveGateStack({
    containers: [
      { name: "app", image: "localhost/app:gate", env, mountWorktree: "/app" },
    ],
    steps: [{ name: "test", in: "app", command: ["npm", "test"] }],
  }).containers[0]!;

const BUILDERS: ReadonlyArray<readonly [string, () => RuntimeInvocation]> = [
  [
    "sandboxRunArgs",
    () =>
      sandboxRunArgs({
        containerName: "sandbar-w0011223-abc",
        imageName: "localhost/sandbar:latest",
        workdir: "/home/agent/workspace",
        env: {
          GH_TOKEN: PAT,
          CLAUDE_CODE_OAUTH_TOKEN: SECRET,
          HOME: "/home/agent",
        },
        volumeMounts: ["/host/wt:/home/agent/workspace:rw,z"],
        userns: "keep-id",
        containerUid: 1000,
        containerGid: 1000,
        networks: ["sandbar-w0011223-net-1"],
        groups: [],
        devices: [],
        cpus: undefined,
      }),
  ],
  [
    "containerRunArgs",
    () =>
      containerRunArgs({
        containerName: "sandbar-42-app",
        attach: { kind: "pod", podName: "sandbar-pod-42" },
        // A consumer's own gate env moves too: `config.env` is not the only
        // record that can hold a credential.
        container: gateContainer({ DB_PASSWORD: SECRET }),
        worktreePath: "/wt",
        hideWorktreeGit: true,
      }),
  ],
  ["stepExecArgs", () => stepExecArgs("sandbar-42-app", ["npm", "test"])],
  [
    "buildResolveRunArgv",
    () =>
      buildResolveRunArgv({
        container: "resolve-1",
        cwd: "/worktree",
        extraMounts: ["/git-common"],
        codexAuthMount: {
          hostPath: "/state/codex-auth.json",
          sandboxPath: "/home/agent/.codex/auth.json",
        },
        image: "sandbox-image",
        credentials: { GH_TOKEN: PAT, OPENAI_API_KEY: SECRET },
        botName: "sandbar-bot",
        botEmail: "bot@example.test",
      }),
  ],
];

// Podman spells an environment flag `-e`, `--env` or `--env-file`; a builder
// emits none of the three, because the one that names a file is spliced in by
// `withRuntimeEnv`, which is also the only reader of `env`.
const ENV_FLAGS = ["-e", "--env", "--env-file"];

describe("a podman argv never carries an environment value (#154)", () => {
  it.each(BUILDERS)("%s emits no environment flag at all", (_name, build) => {
    const { argv, env } = build();
    for (const flag of ENV_FLAGS) expect(argv).not.toContain(flag);
    expect(Object.keys(env).length).toBeGreaterThan(0);
  });

  // Checked as the PAIR rather than as the bare value, because a value can
  // legitimately be an argv substring by another route: the sandbox's `HOME` is
  // the parent of its `-w` workdir, the resolve container's `CODEX_HOME` is the
  // directory of a mount the same argv names, and `CI=true` shares its value
  // with the `sandbar=true` label.
  it.each(BUILDERS)("%s emits no KEY=VALUE token", (_name, build) => {
    const { argv, env } = build();
    const joined = argv.join(" ");
    for (const [key, value] of Object.entries(env)) {
      expect(joined).not.toContain(`${key}=${value}`);
    }
  });

  // And the unambiguous half, which is what the issue reported: a
  // credential-shaped value appears nowhere in the argv by any route, so no
  // `Command failed: <argv joined>` wrapper can quote one into the record.
  it.each(BUILDERS)("%s leaks no credential-shaped value", (_name, build) => {
    const { argv } = build();
    for (const secret of [SECRET, PAT]) {
      expect(argv.join(" ")).not.toContain(secret);
    }
  });

  // The names that make the env file the mechanism rather than podman's own
  // value-free `-e KEY`: `HOME` is a rootless client's storage root and config
  // directory, and `CONTAINER_HOST` is the service URL — which this repo's gate
  // config declares on a gate container, naming a socket that exists only
  // inside it (#48). `-e KEY` would have required both in PODMAN's environment,
  // reconfiguring the client; the file carries them to the container instead,
  // and `withRuntimeEnv` hands its caller nothing but an argv.
  it.each([
    ["HOME", "/home/agent"],
    ["CONTAINER_HOST", "unix:///run/podman.sock"],
  ])("carries a container's %s in the file, not to podman", async (key, value) => {
    let seen: readonly string[] = [];
    await withRuntimeEnv(
      { argv: ["run", "image"], env: { [key]: value } },
      async (argv) => {
        seen = argv;
        const at = argv.indexOf("--env-file");
        expect(await readFile(argv[at + 1]!, "utf8")).toBe(`${key}=${value}\n`);
      },
    );
    // Spliced after the SUBCOMMAND, which is the slot every builder's argv
    // still reads flags in — `run`'s first positional is the image.
    expect(seen.slice(0, 2)).toEqual(["run", "--env-file"]);
    expect(seen.at(-1)).toBe("image");
  });
});

// The scan the header promises. Podman spells its environment flags `-e`,
// `--env` and `--env-file`, and an argv element is a STRING LITERAL — prose
// quotes them in backticks, which is why those three forms are what is banned
// and why every header that states the rule is untouched by this.
const SRC = dirname(fileURLToPath(import.meta.url));
const ENV_FLAG = /["'](?:-e|--env|--env-file)["']/g;
const ENV_FLAG_HOME = "runtime.ts";

const envFlagCount = (source: string): number =>
  [...source.matchAll(ENV_FLAG)].length;

describe("podman's environment flags have one production spelling (#154)", () => {
  it("counts every spelling podman accepts", () => {
    expect(
      envFlagCount('["-e", k]; ["--env", k]; ["--env-file", p]; `-e` in prose'),
    ).toBe(3);
  });

  it("is written in runtime.ts and in no other production module", async () => {
    const files = (await readdir(SRC)).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test-util.ts"),
    );
    const offenders: string[] = [];
    let home = 0;
    for (const file of files.sort()) {
      const count = envFlagCount(await readFile(join(SRC, file), "utf8"));
      if (file === ENV_FLAG_HOME) home = count;
      else if (count > 0) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // And the home itself still has it, so a rename cannot leave the scan
    // asserting a rule nothing enforces any more.
    expect(home).toBe(1);
  });
});

describe("formatEnvFile", () => {
  it("writes one KEY=VALUE line per variable, in insertion order", () => {
    expect(formatEnvFile({ B: "2", A: "sk-ant=oat#01" })).toBe(
      "B=2\nA=sk-ant=oat#01\n",
    );
  });

  it("is empty for an empty record", () => {
    expect(formatEnvFile({})).toBe("");
  });

  // Podman parses the file line by line, so a value it cannot represent must be
  // refused rather than written: a garbled variable is a silently wrong
  // environment for the agent or the gate, which is worse than a named refusal.
  it.each([
    ["a newline", { KEY: "line\nKEY2=injected" }],
    ["a carriage return", { KEY: "a\rb" }],
    ["a NUL", { KEY: "a\0b" }],
  ])("refuses a value containing %s", (_what, env) => {
    expect(() => formatEnvFile(env)).toThrow(SandbarError);
  });

  it.each([["# comment"], ["A=B"], [" LEADING"], ["1DIGIT"], [""]])(
    "refuses the name %j, which would not read back as itself",
    (key) => {
      expect(() => formatEnvFile({ [key]: "v" })).toThrow(SandbarError);
    },
  );
});

describe("withRuntimeEnv", () => {
  it("removes the file once the command it was written for returns", async () => {
    let path = "";
    await withRuntimeEnv({ argv: ["run"], env: { A: "1" } }, async (argv) => {
      path = argv[argv.indexOf("--env-file") + 1]!;
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
    await expect(stat(path)).rejects.toThrow();
  });

  it("removes it after a failing command too, and raises that failure", async () => {
    let path = "";
    await expect(
      withRuntimeEnv({ argv: ["run"], env: { A: "1" } }, async (argv) => {
        path = argv[argv.indexOf("--env-file") + 1]!;
        throw new Error("podman run failed");
      }),
    ).rejects.toThrow("podman run failed");
    await expect(stat(path)).rejects.toThrow();
  });

  // An argv that needs nothing gets no file and no flag, so the invocation a
  // builder emits for an empty env is the argv it wrote.
  it("writes no file for a builder that needs no variables", async () => {
    const argv = ["run", "image"];
    await withRuntimeEnv({ argv, env: {} }, async (passed) => {
      expect(passed).toBe(argv);
    });
  });
});
