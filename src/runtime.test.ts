// The enforcer for runtime.ts's one rule: A PODMAN ARGV NEVER HAS `=` AFTER
// `-e` (#154).
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
// the author of a `KEY=VALUE` regression is exactly who would not. So the scan
// below carries the other half, the way error-swallow-ratchet.test.ts does for
// its own rule: `envArgs` in runtime.ts is the ONE production spelling of the
// flag, so any other module that writes it as a string literal fails here.
// Between them, a new builder either goes through `envArgs` — which cannot
// emit a value — or it announces itself.
//
// Each case supplies credential-SHAPED values, so the second half of the check
// — no value appears anywhere in the argv — is testing what the issue reported
// rather than a placeholder.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sandboxRunArgs } from "./agent-sandbox.js";
import { resolveGateStack } from "./config.js";
import { containerRunArgs, stepExecArgs } from "./gate-stack.js";
import { buildResolveRunArgv } from "./merger.js";
import { envArgs, runtimeChildEnv, type RuntimeInvocation } from "./runtime.js";

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
  [
    "stepExecArgs",
    () => stepExecArgs("sandbar-42-app", ["npm", "test"]),
  ],
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

// Every token immediately after a `-e`, which is what podman reads as the
// variable specification.
const specs = (argv: readonly string[]): string[] =>
  argv.filter((_, i) => i > 0 && argv[i - 1] === "-e");

describe("a podman argv never has `=` after -e (#154)", () => {
  it.each(BUILDERS)("%s emits bare keys only", (_name, build) => {
    const { argv } = build();
    for (const spec of specs(argv)) expect(spec).not.toContain("=");
  });

  it.each(BUILDERS)("%s carries a value for every key it names", (_name, build) => {
    const { argv, env } = build();
    for (const key of specs(argv)) expect(env).toHaveProperty(key);
  });

  // The other direction, and the one that makes the first meaningful: a
  // builder cannot satisfy "bare keys only" by naming the key after `-e` and
  // ALSO emitting the pair somewhere else in the argv — `--env KEY=VALUE` and
  // a stray `-e` the filter above happens not to sit behind are both still a
  // leak. Checked as the PAIR rather than as the bare value, because a value
  // can legitimately be an argv substring by another route: the resolve
  // container's `CODEX_HOME` is the directory of a mount the same argv names.
  it.each(BUILDERS)("%s emits no KEY=VALUE token at all", (_name, build) => {
    const { argv, env } = build();
    for (const [key, value] of Object.entries(env)) {
      expect(specs(argv)).toContain(key);
      expect(argv).not.toContain(`${key}=${value}`);
    }
  });
});

// The scan the header promises. Podman spells the flag `-e` or `--env`, and an
// argv element is a STRING LITERAL — prose quotes it in backticks, which is
// why those two forms are what is banned and why every header that states the
// rule is untouched by this.
const SRC = dirname(fileURLToPath(import.meta.url));
const ENV_FLAG = /["'](?:-e|--env)["']/g;
const ENV_FLAG_HOME = "runtime.ts";

const envFlagCounts = (source: string): number =>
  [...source.matchAll(ENV_FLAG)].length;

describe("the -e flag has one production spelling (#154)", () => {
  it("counts the flag in either of podman's spellings", () => {
    expect(envFlagCounts('["-e", key]; ["--env", key]; `-e` in prose')).toBe(2);
  });

  it("is written in runtime.ts and in no other production module", async () => {
    const files = (await readdir(SRC))
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !file.endsWith(".test-util.ts"),
      )
      .sort();
    const counts = Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          envFlagCounts(await readFile(join(SRC, file), "utf8")),
        ]),
      ),
    ) as Record<string, number>;

    expect(
      Object.entries(counts).filter(
        ([file, count]) => count > 0 && file !== ENV_FLAG_HOME,
      ),
    ).toEqual([]);
    // And the home itself still has it, so a rename cannot leave the scan
    // asserting a rule nothing enforces any more.
    expect(counts[ENV_FLAG_HOME]).toBe(1);
  });
});

describe("runtimeChildEnv", () => {
  // Node hands a child `env` verbatim, so replacing the driver's environment
  // instead of overlaying it would strip PATH, HOME and XDG_RUNTIME_DIR —
  // without which podman cannot find its socket.
  it("overlays the pairs on the driver's own environment", () => {
    const merged = runtimeChildEnv({ GH_TOKEN: PAT });
    expect(merged?.["GH_TOKEN"]).toBe(PAT);
    expect(merged?.["PATH"]).toBe(process.env["PATH"]);
  });

  // Absent means absent: `execFile`/`spawn` inherit when the option is
  // undefined, and manufacturing a copy of `process.env` here would be the
  // same thing said less clearly.
  it("passes no env option when there is nothing to add", () => {
    expect(runtimeChildEnv(undefined)).toBeUndefined();
  });
});

describe("envArgs", () => {
  it("names each key once, in insertion order", () => {
    expect(envArgs({ B: "2", A: "1" })).toEqual(["-e", "B", "-e", "A"]);
  });

  it("emits nothing for an empty record", () => {
    expect(envArgs({})).toEqual([]);
  });
});
