import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  resolveConfig: vi.fn((config: object) => config),
}));

import { main } from "./cli.js";

describe("sandbar pulled-images entrypoint", () => {
  it("prints each referenced image config.images does not build, one per line", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sandbar-cli-pulled-"));
    await writeFile(
      join(cwd, "sandbar.config.mjs"),
      `export default {
        images: [{ tag: "localhost/runner" }],
        gateStack: { kind: "inline", stack: { containers: [
          { image: "localhost/runner" },
          { image: "docker.io/axllent/mailpit:v1.31.1" },
          { image: "docker.io/library/postgres:16" },
          { image: "docker.io/axllent/mailpit:v1.31.1" },
        ] } },
      };\n`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["pulled-images"], cwd)).resolves.toBe(0);
    expect(log.mock.calls).toEqual([
      ["docker.io/axllent/mailpit:v1.31.1"],
      ["docker.io/library/postgres:16"],
    ]);
    log.mockRestore();
  });

  // #186: the play pulls what the clone it has just updated declares.
  it("reads a stack file from the config's cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sandbar-cli-pulled-file-"));
    await mkdir(join(cwd, "gate"));
    await writeFile(
      join(cwd, "gate", "stack.json"),
      JSON.stringify({
        images: "ignored by sandbar",
        containers: [
          { name: "app", image: "localhost/runner", mountWorktree: "/w", hold: true },
          { name: "db", image: "docker.io/library/postgres:16", lifecycle: "issue" },
        ],
        steps: [{ name: "test", in: "app", command: ["true"] }],
      }),
    );
    await writeFile(
      join(cwd, "sandbar.config.mjs"),
      `export default {
        env: {},
        images: [{ tag: "localhost/runner" }],
        gateStack: { kind: "file", path: "gate/stack.json" },
      };\n`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["pulled-images"], cwd)).resolves.toBe(0);
    expect(log.mock.calls).toEqual([["docker.io/library/postgres:16"]]);
    log.mockRestore();
  });
});
