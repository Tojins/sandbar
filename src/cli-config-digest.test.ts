import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { main } from "./cli.js";

// Through the real `resolveConfig`: the digest is of the EVALUATED config, so
// the entrypoint must not hand it anything `resolveConfig` did not produce.
const config = (images: string, containers: string) => `export default {
  ghOwner: "o",
  ghRepo: "r",
  developers: "anyone",
  sandboxImage: "localhost/sandbox",
  images: ${images},
  gateStack: {
    containers: ${containers},
    steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
  },
};\n`;

async function digestPrinted(source: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "sandbar-cli-digest-"));
  await writeFile(join(cwd, "sandbar.config.mjs"), source);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await expect(main(["config-digest"], cwd)).resolves.toBe(0);
    expect(log.mock.calls).toHaveLength(1);
    return String(log.mock.calls[0]![0]);
  } finally {
    log.mockRestore();
  }
}

describe("sandbar config-digest entrypoint", () => {
  it("prints one digest that ignores key order and moves with an image tag", async () => {
    const digest = await digestPrinted(config(
      `[{ tag: "localhost/sandbox", containerfile: "Containerfile" }]`,
      `[{ name: "runner", image: "localhost/sandbox", mountWorktree: "/w", hold: true }]`,
    ));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    await expect(digestPrinted(config(
      `[{ containerfile: "Containerfile", tag: "localhost/sandbox" }]`,
      `[{ hold: true, mountWorktree: "/w", image: "localhost/sandbox", name: "runner" }]`,
    ))).resolves.toBe(digest);
    await expect(digestPrinted(config(
      `[{ tag: "localhost/sandbox", containerfile: "Containerfile" }]`,
      `[{ name: "runner", image: "localhost/sandbox", mountWorktree: "/w", hold: true },
        { name: "db", image: "docker.io/library/mariadb:11.4", lifecycle: "issue" }]`,
    ))).resolves.not.toBe(digest);
  });
});
