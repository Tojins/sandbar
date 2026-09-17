import { mkdtemp, writeFile } from "node:fs/promises";
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
        gateStack: { containers: [
          { image: "localhost/runner" },
          { image: "docker.io/axllent/mailpit:v1.31.1" },
          { image: "docker.io/library/postgres:16" },
          { image: "docker.io/axllent/mailpit:v1.31.1" },
        ] },
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
});
