// The enforcer for runtime.ts's one rule: A PODMAN ARGV NEVER HAS `=` AFTER
// `-e` (#154).
//
// It lives here rather than beside any one builder because it is a claim about
// ALL of them at once, and the four are in three modules. The argument the
// issue rests on is that no wrapper anywhere can leak a credential it never
// saw — node's `execFile` error message is `Command failed: <argv joined>`, and
// the inner loop records that as a `hard-error` event `reason` the UI then
// serves (#132). That argument holds only while every builder obeys, so the
// invariant is asserted over the set, not per builder: a fifth builder added
// with `KEY=VALUE` beside its siblings is exactly the regression this catches,
// and it is text-shaped, so it needs an assertion rather than a comment.
//
// Each case supplies credential-SHAPED values, so the second half of the check
// — no value appears anywhere in the argv — is testing what the issue reported
// rather than a placeholder.
import { describe, expect, it } from "vitest";

import { sandboxRunArgs } from "./agent-sandbox.js";
import { containerRunArgs, stepExecArgs } from "./gate-stack.js";
import { buildResolveRunArgv } from "./merger.js";
import { envArgs, runtimeChildEnv, type RuntimeInvocation } from "./runtime.js";
import type { ResolvedStackContainer } from "./config.js";

const SECRET = "sk-ant-oat01-thisisthewholetoken";
const PAT = "ghp_thisisthewholepat";

const gateContainer = (
  over: Partial<ResolvedStackContainer> = {},
): ResolvedStackContainer => ({
  name: "app",
  image: "localhost/app:gate",
  lifecycle: "attempt",
  env: {},
  args: [],
  mounts: [],
  mountWorktree: null,
  servesWorktree: false,
  hold: false,
  readiness: null,
  readinessTimeoutMs: 60_000,
  postReadyCommands: [],
  ...over,
});

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
        container: gateContainer({
          env: { DB_PASSWORD: SECRET, CI: "false" },
          mountWorktree: "/app",
        }),
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
