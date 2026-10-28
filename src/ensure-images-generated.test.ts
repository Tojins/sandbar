import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildGeneratedImage } from "./ensure-images.js";
import { gateScope } from "./naming.js";

const scope = gateScope("/generated-image-test");

describe("buildGeneratedImage", () => {
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
  });

  it("removes the context when the build rejects", async () => {
    const { result, root } = run(async () => {
      throw new Error("build failed");
    });
    await expect(result).rejects.toThrow("build failed");
    expect(existsSync(root())).toBe(false);
  });
});
