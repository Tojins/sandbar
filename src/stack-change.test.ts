// The env/non-env rule a branch's stack file is held to (#186), table-tested
// over stacks resolved the way a stack file is.

import { describe, expect, it } from "vitest";

import {
  type GateStackConfig,
  type ResolvedStack,
  type StackContainer,
  resolveGateStack,
  sandboxGateAttachmentsOf,
} from "./config.js";
import {
  type BranchStackRead,
  classifyStackChange,
  overlayBranchEnv,
  renderStackDifferences,
  stackInEffect,
} from "./stack-change.js";
import { stackSpecToken } from "./stack-source.js";

const PATH = "gate/stack.json";

const db = (over: Partial<StackContainer> = {}): StackContainer => ({
  name: "db",
  image: "docker.io/library/mariadb:10.11",
  lifecycle: "issue",
  env: { MARIADB_ROOT_PASSWORD: "root" },
  ...over,
});
const app = (over: Partial<StackContainer> = {}): StackContainer => ({
  name: "app",
  image: "localhost/app:gate",
  mountWorktree: "/w",
  hold: true,
  env: { DB_HOST: "127.0.0.1" },
  ...over,
});
const test = { name: "test", in: "app", command: ["npm", "test"] };

const config = (over: Partial<GateStackConfig> = {}): GateStackConfig => ({
  containers: [db(), app()],
  steps: [test],
  ...over,
});
const resolve = (stack: GateStackConfig) => resolveGateStack(stack, PATH);
const ok = (stack: GateStackConfig): BranchStackRead => ({
  kind: "ok",
  stack: resolve(stack),
});
const tip = resolve(config());
const classify = (branch: BranchStackRead) => classifyStackChange(PATH, tip, branch);

describe("classifyStackChange", () => {
  it("is `same` for an identical stack and for spelled-out defaults", () => {
    expect(classify(ok(config()))).toEqual({ kind: "same" });
    expect(classify(ok(config({
      containers: [
        db({ args: [], mounts: [], inSandbox: false, hold: false }),
        app({ lifecycle: "attempt", servesWorktree: false }),
      ],
      steps: [{ ...test, timeoutMs: 15 * 60 * 1000 }],
    })))).toEqual({ kind: "same" });
  });

  it.each([
    ["changed", { MARIADB_ROOT_PASSWORD: "other" }],
    ["added", { MARIADB_ROOT_PASSWORD: "root", TZ: "Europe/Brussels" }],
    ["removed", {}],
  ])("is `env-only` for an env value %s, naming its container", (_, env) => {
    expect(classify(ok(config({ containers: [db({ env }), app()] })))).toEqual({
      kind: "env-only",
      containers: ["db"],
    });
  });

  it("names every container whose env changed", () => {
    expect(classify(ok(config({
      containers: [db({ env: { TZ: "Europe/Brussels" } }), app({ env: { TZ: "Europe/Brussels" } })],
    })))).toEqual({ kind: "env-only", containers: ["db", "app"] });
  });

  it.each<[string, GateStackConfig, readonly { where: string; what: string }[]]>([
    [
      "a mount",
      config({ containers: [db({ mounts: [{ hostPath: "/etc", containerPath: "/x" }] }), app()] }),
      [{ where: "container 'db'", what: "mounts" }],
    ],
    [
      "an image",
      config({ containers: [db({ image: "docker.io/library/mariadb:11" }), app()] }),
      [{ where: "container 'db'", what: "image" }],
    ],
    [
      "hold",
      config({ containers: [db({ hold: true }), app()] }),
      [{ where: "container 'db'", what: "hold" }],
    ],
    [
      "the lifecycle",
      config({ containers: [db({ lifecycle: "attempt" }), app()] }),
      [{ where: "container 'db'", what: "lifecycle" }],
    ],
    [
      "readiness",
      config({
        containers: [
          db({ readiness: { kind: "healthcheck", command: ["true"] } }),
          app(),
        ],
      }),
      [{ where: "container 'db'", what: "readiness" }],
    ],
    [
      "an added container",
      config({ containers: [db(), app(), { name: "mailhog", image: "docker.io/mailhog/mailhog" }] }),
      [{ where: "containers", what: "'mailhog' added" }],
    ],
    [
      "a removed container",
      config({ containers: [app()] }),
      [{ where: "containers", what: "'db' removed" }],
    ],
    [
      "a reordered container",
      config({ containers: [app(), db()] }),
      [{ where: "containers", what: "order" }],
    ],
    [
      "a step's command",
      config({ steps: [{ ...test, command: ["true"] }] }),
      [{ where: "step 'test'", what: "command" }],
    ],
    [
      "a step's timeout",
      config({ steps: [{ ...test, timeoutMs: 1000 }] }),
      [{ where: "step 'test'", what: "timeoutMs" }],
    ],
    [
      "an added step",
      config({ steps: [test, { name: "lint", in: "app", command: ["npm", "run", "lint"] }] }),
      [{ where: "steps", what: "'lint' added" }],
    ],
  ])("is `non-env` for %s", (_, branch, differences) => {
    expect(classify(ok(branch))).toEqual({ kind: "non-env", path: PATH, differences });
  });

  it("is `non-env` when the branch has no stack file, or an invalid one", () => {
    expect(classify({ kind: "missing" })).toEqual({
      kind: "non-env",
      path: PATH,
      differences: [{ where: PATH, what: "missing" }],
    });
    expect(classify({ kind: "invalid", message: "gate/stack.json at abc: not valid JSON" }))
      .toEqual({
        kind: "non-env",
        path: PATH,
        differences: [{ where: PATH, what: "does not validate: gate/stack.json at abc: not valid JSON" }],
      });
  });
});

describe("overlayBranchEnv", () => {
  it("takes only env from the branch", () => {
    const branch = resolve(config({
      containers: [db({ env: { TZ: "Europe/Brussels" }, image: "elsewhere" }), app()],
      steps: [{ ...test, command: ["true"] }],
    }));
    const overlay = overlayBranchEnv(tip, branch);
    expect(overlay.containers[0]).toEqual({ ...tip.containers[0], env: { TZ: "Europe/Brussels" } });
    expect(overlay.containers[1]).toEqual(tip.containers[1]);
    expect(overlay.steps).toBe(tip.steps);
  });
});

describe("stackInEffect", () => {
  const tipStack: ResolvedStack = { stack: tip, attachments: sandboxGateAttachmentsOf(tip, {}) };

  it("is the tip's stack for `same` and `non-env`", () => {
    expect(stackInEffect(PATH, tipStack, ok(config()), {}))
      .toEqual({ ...tipStack, classification: { kind: "same" } });
    const mounted = stackInEffect(PATH, tipStack, ok(config({ containers: [db(), app({ hold: false, lifecycle: "attempt" })] })), {});
    expect(mounted.stack).toBe(tip);
    expect(mounted.classification.kind).toBe("non-env");
  });

  it("lays the branch's env over the tip for `env-only`, attachments included", () => {
    const inEffect = stackInEffect(
      PATH,
      tipStack,
      ok(config({ containers: [db(), app({ env: { TZ: "Europe/Brussels" } })] })),
      {},
    );
    expect(inEffect.classification).toEqual({ kind: "env-only", containers: ["app"] });
    expect(inEffect.stack.containers[1]?.env).toEqual({ TZ: "Europe/Brussels" });
    expect(inEffect.attachments.env).toEqual({ TZ: "Europe/Brussels" });
  });

  it("is `non-env` when the overlaid env collides with config.env", () => {
    const inEffect = stackInEffect(
      PATH,
      tipStack,
      ok(config({ containers: [db(), app({ env: { GH_TOKEN: "x" } })] })),
      { GH_TOKEN: "secret" },
    );
    expect(inEffect.stack).toBe(tip);
    expect(inEffect.classification).toEqual({
      kind: "non-env",
      path: PATH,
      differences: [{
        where: PATH,
        what: expect.stringMatching(/^does not validate: gate\/stack\.json: step container 'app' sets env key 'GH_TOKEN'/),
      }],
    });
  });
});

describe("stackSpecToken", () => {
  it("differs for an env change and not for reordered keys", () => {
    const reordered = resolve({
      steps: [{ command: ["npm", "test"], in: "app", name: "test" }],
      containers: [
        { env: { MARIADB_ROOT_PASSWORD: "root" }, lifecycle: "issue", image: "docker.io/library/mariadb:10.11", name: "db" },
        app(),
      ],
    });
    expect(stackSpecToken(reordered)).toBe(stackSpecToken(tip));
    const envChanged = resolve(config({ containers: [db({ env: { TZ: "UTC" } }), app()] }));
    expect(stackSpecToken(envChanged)).not.toBe(stackSpecToken(tip));
  });
});

describe("renderStackDifferences", () => {
  it("renders one bullet per difference", () => {
    expect(renderStackDifferences([
      { where: "container 'db'", what: "mounts" },
      { where: "containers", what: "'mailhog' added" },
    ])).toBe("- container 'db': mounts\n- containers: 'mailhog' added");
  });
});
