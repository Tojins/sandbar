import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildGeneratedImage } from "./ensure-images.js";
import { gateScope } from "./naming.js";

const disposable = vi.hoisted(() => ({
  withdraw: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  registered: 0,
}));

vi.mock("./cleanup.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cleanup.js")>(),
  registerDisposable: () => {
    disposable.registered++;
    return disposable.withdraw;
  },
}));

const scope = gateScope("/generated-image-test");

describe("buildGeneratedImage", () => {
  beforeEach(() => {
    disposable.withdraw = vi.fn();
    disposable.registered = 0;
  });

  const run = (build: (contextRoot: string) => Promise<void>) => {
    let root = "";
    const result = buildGeneratedImage({
      tag: "t",
      identity: "<generated>",
      files: { Containerfile: "FROM x\n", blob: new Uint8Array([0, 255, 1]) },
      fingerprint: "fp",
      scope,
      build: async (_image, opts) => {
        root = opts.contextRoot ?? "";
        await build(root);
      },
    });
    return { result, root: () => root };
  };

  it("writes every file, bytes included, for the build and removes the context after", async () => {
    let seen: { text: string; blob: number[] } | null = null;
    const { result, root } = run(async (dir) => {
      seen = {
        text: readFileSync(join(dir, "Containerfile"), "utf8"),
        blob: [...readFileSync(join(dir, "blob"))],
      };
    });
    await result;
    expect(seen).toEqual({ text: "FROM x\n", blob: [0, 255, 1] });
    expect(existsSync(root())).toBe(false);
    expect(disposable.registered).toBe(1);
    expect(disposable.withdraw).toHaveBeenCalledTimes(1);
  });

  it("removes the context when the build rejects", async () => {
    const { result, root } = run(async () => {
      throw new Error("build failed");
    });
    await expect(result).rejects.toThrow("build failed");
    expect(existsSync(root())).toBe(false);
    expect(disposable.registered).toBe(1);
    expect(disposable.withdraw).toHaveBeenCalledTimes(1);
  });
});
