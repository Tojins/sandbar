import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./cli.js";
import * as dbBase from "./db-base.js";
import { SandbarError } from "./errors.js";

vi.mock("./db-base.js", async (original) => {
  const actual = await original<typeof import("./db-base.js")>();
  return { ...actual, runDbBaseJob: vi.fn(actual.runDbBaseJob) };
});

// The entrypoint's own part (#201): resolve the target from the stack the
// config names, as `pulled-images` reads it, before any import starts.
const stackFile = (inSandbox: boolean) => JSON.stringify({
  containers: [
    {
      name: "db",
      image: "docker.io/library/mariadb:10.11",
      inSandbox,
      readiness: { kind: "healthcheck", command: ["healthcheck.sh", "--connect"] },
    },
    { name: "runner", image: "localhost/sandbox", mountWorktree: "/w", hold: true },
  ],
  steps: [{ name: "test", in: "runner", command: ["true"] }],
});

const config = (root: string, databaseCopies: boolean) => `export default {
  ghOwner: "o",
  ghRepo: "r",
  developers: "anyone",
  sandboxImage: "localhost/sandbox",
  gateStack: { path: "gate/stack.json" },
  ${databaseCopies ? `databaseCopies: {
    dump: ${JSON.stringify(join(root, "drop/app-latest.sql.gz"))},
    root: ${JSON.stringify(join(root, "base"))},
    container: "db",
    database: "app",
  },` : ""}
};\n`;

describe("sandbar db-base entrypoint", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sandbar-cli-db-base-"));
    await mkdir(join(cwd, "gate"));
    await mkdir(join(cwd, "base"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses a config without databaseCopies", async () => {
    await writeFile(join(cwd, "sandbar.config.mjs"), config(cwd, false));
    await writeFile(join(cwd, "gate/stack.json"), stackFile(true));
    await expect(main(["db-base"], cwd)).rejects.toThrow(/sets no databaseCopies/);
  });

  it("refuses a target the stack file in the clone cannot copy, naming the file", async () => {
    await writeFile(join(cwd, "sandbar.config.mjs"), config(cwd, true));
    await writeFile(join(cwd, "gate/stack.json"), stackFile(false));
    await expect(main(["db-base"], cwd)).rejects.toThrow(new SandbarError(
      `${join(cwd, "gate/stack.json")}: config.databaseCopies.container 'db' ` +
        "must set inSandbox: a copy replaces its sandbox sibling.",
    ));
  });

  it("exits 1 when the job reports a failed import", async () => {
    await writeFile(join(cwd, "sandbar.config.mjs"), config(cwd, true));
    await writeFile(join(cwd, "gate/stack.json"), stackFile(true));
    vi.mocked(dbBase.runDbBaseJob).mockResolvedValueOnce("import-failed");
    await expect(main(["db-base"], cwd)).resolves.toBe(1);
  });

  it("exits 0 with nothing to import while the drop is empty", async () => {
    await writeFile(join(cwd, "sandbar.config.mjs"), config(cwd, true));
    await writeFile(join(cwd, "gate/stack.json"), stackFile(true));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(main(["db-base"], cwd)).resolves.toBe(0);
      expect(log.mock.calls).toEqual([[`db-base: no dump at ${join(cwd, "drop/app-latest.sql.gz")}`]]);
    } finally {
      log.mockRestore();
    }
  });
});
