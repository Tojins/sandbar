import { describe, expect, it } from "vitest";

import { configDigest } from "./config-digest.js";
import { resolveGateStack, resolveImages, type BuiltImage, type GateStackConfig } from "./config.js";

// Each case evaluates a stack.json-shaped document the way an installation
// config does — `gateStack: { containers, steps }`, `images: [...stack.images,
// sandbox]` — through the same resolvers `resolveConfig` uses.
type StackJson = {
  readonly anchor?: unknown;
  readonly half?: unknown;
  readonly comment?: unknown;
  readonly images: readonly (BuiltImage & Record<string, unknown>)[];
  readonly containers: GateStackConfig["containers"];
  readonly steps: GateStackConfig["steps"];
};

const SANDBOX = "localhost/sandbar:outdoor";

const base: StackJson = {
  images: [
    { tag: "localhost/outdoor-php71:gate", containerfile: "gate/php/Containerfile" },
  ],
  containers: [
    {
      name: "db",
      image: "docker.io/library/mariadb:10.11",
      lifecycle: "issue",
      env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "outdoor" },
    },
    {
      name: "php",
      image: "localhost/outdoor-php71:gate",
      mountWorktree: "/workspace",
      hold: true,
    },
  ],
  steps: [{ name: "phpunit", in: "php", command: ["vendor/bin/phpunit"] }],
};

function evaluate(stack: StackJson) {
  const gateStack = resolveGateStack({ containers: stack.containers, steps: stack.steps });
  const images = resolveImages(
    [...stack.images, { tag: SANDBOX, containerfile: "Containerfile.sandbar" }],
    SANDBOX,
  );
  return { gateStack, images };
}

const digestOf = (stack: StackJson): string => configDigest(evaluate(stack));

// Rebuilds every object in the document with its keys in reverse order.
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]),
  ) as T;
}

const renamedTag: StackJson = {
  ...base,
  images: [{ tag: "localhost/outdoor-php:gate", containerfile: "gate/php/Containerfile" }],
  containers: base.containers.map((c) =>
    c.name === "php" ? { ...c, image: "localhost/outdoor-php:gate" } : c),
};

const addedContainer: StackJson = {
  ...base,
  containers: [
    ...base.containers,
    { name: "mail", image: "docker.io/axllent/mailpit:v1.31.1", lifecycle: "issue" },
  ],
};

const newPulledTag: StackJson = {
  ...base,
  containers: base.containers.map((c) =>
    c.name === "db" ? { ...c, image: "docker.io/library/mariadb:11.4" } : c),
};

const annotated: StackJson = {
  ...base,
  anchor: "gate/README.md",
  half: "backend",
  comment: "the backend gate",
  images: base.images.map((i) => ({ ...i, comment: "PHP 7.1 runtime", half: "backend" })),
  containers: base.containers.map((c) => ({ ...c, comment: `the ${c.name} sidecar` })),
  steps: base.steps.map((s) => ({ ...s, anchor: "phpunit.xml", half: "backend" })),
};

describe("configDigest", () => {
  it("is a sha256 in hex", () => {
    expect(digestOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["the same document", base],
    ["every object's keys reordered", reversedKeys(base)],
    ["keys sandbar ignores (anchor, half, comment) added", annotated],
  ])("is unchanged by %s", (_label, stack) => {
    expect(digestOf(stack)).toBe(digestOf(base));
  });

  it.each([
    ["a renamed image tag", renamedTag],
    ["an added container", addedContainer],
    ["a new pulled tag", newPulledTag],
    ["a reordered image list", {
      ...base,
      images: [
        { tag: "localhost/runner:gate", containerfile: "gate/runner/Containerfile" },
        ...base.images,
      ],
    }],
  ])("changes for %s", (_label, stack) => {
    expect(digestOf(stack)).not.toBe(digestOf(base));
  });

  it.each<[string, Partial<BuiltImage>]>([
    ["context", { context: "gate/php" }],
    ["target", { target: "runtime" }],
    ["stdinContext", { stdinContext: true }],
    ["buildArgs", { buildArgs: { PHP_VERSION: "8.4" } }],
    ["rebuildOn", { rebuildOn: ["gate/php/composer.lock"] }],
    ["buildTimeoutMs", { buildTimeoutMs: 60_000 }],
  ])("changes for an image's %s", (_field, change) => {
    const changed: StackJson = {
      ...base,
      images: base.images.map((i) => ({ ...i, ...change })),
    };
    expect(digestOf(changed)).not.toBe(digestOf(base));
  });

  it("changes for different content in the same image field", () => {
    const withArgs = (v: string): StackJson => ({
      ...base,
      images: base.images.map((i) => ({ ...i, buildArgs: { V: v } })),
    });
    expect(digestOf(withArgs("1"))).not.toBe(digestOf(withArgs("2")));
  });

  it("is unchanged by a key on an image that sandbar has no concept of", () => {
    const unknown: StackJson = {
      ...base,
      images: base.images.map((i) => ({ ...i, sandbarFutureField: "x" })),
    };
    expect(digestOf(unknown)).toBe(digestOf(base));
  });

  it("refuses a config member it cannot serialise", () => {
    const { gateStack, images } = evaluate(base);
    const withFunction = { gateStack: { ...gateStack, extra: () => 1 }, images };
    expect(() => configDigest(withFunction as never)).toThrow(/cannot serialise/);
  });
});
