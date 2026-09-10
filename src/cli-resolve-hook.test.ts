// #148 — the bin makes its own package available to configs anywhere on disk.
//
// This runs a real Node child against dist/cli.js. Vitest's module runner owns
// imports in its worker, so an in-process test would bypass Node's registered
// resolve hooks and test a different loader from the one the bin uses.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const CLI_URL = new URL("../dist/cli.js", import.meta.url).href;
const DRIVER_URL = new URL("../dist/index.js", import.meta.url).href;

// Load the package entry before the CLI registers its hook, then make the
// config return the namespace it obtained from `"sandbar"`. Object identity is
// the proof that the config did not find and instantiate another driver copy.
const PROBE = `
const runningDriver = await import(${JSON.stringify(DRIVER_URL)});
const { loadConfig } = await import(${JSON.stringify(CLI_URL)});
const config = await loadConfig(process.argv[1]);
if (config.driver !== runningDriver) {
  throw new Error("config imported a different sandbar module instance");
}
process.stdout.write("same driver\\n");
`;

const LIBRARY_PROBE = `
import { pathToFileURL } from "node:url";
await import(${JSON.stringify(DRIVER_URL)});
try {
  await import(pathToFileURL(process.argv[1]).href);
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("sandbar")) {
    process.stdout.write("no hook\\n");
  } else {
    throw error;
  }
}
`;

describe("CLI sandbar resolve hook", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function writeConfig(dir: string): Promise<string> {
    const configPath = join(dir, "sandbar.config.mjs");
    await writeFile(
      configPath,
      'import * as driver from "sandbar";\nexport default { driver };\n',
    );
    return configPath;
  }

  function probe(configPath: string): string {
    return execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", PROBE, configPath],
      { encoding: "utf8" },
    );
  }

  it("ships the hook beside the compiled CLI", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly files: readonly string[] };
    expect(manifest.files).toContain("sandbar-resolve-hook.mjs");
  });

  it("loads an external config through dist/cli.js with this driver instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-external-config-"));
    dirs.push(dir);
    expect(probe(await writeConfig(dir))).toBe("same driver\n");
  });

  it("does not change resolution for package-root library consumers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-library-config-"));
    dirs.push(dir);
    const configPath = await writeConfig(dir);

    expect(execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", LIBRARY_PROBE, configPath],
      { encoding: "utf8" },
    )).toBe("no hook\n");
  });

  it("keeps a consumer devDependency on the identical driver", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-consumer-config-"));
    dirs.push(dir);
    const dependency = join(dir, "node_modules", "sandbar");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await symlink(fileURLToPath(new URL("..", import.meta.url)), dependency, "dir");

    expect(probe(await writeConfig(dir))).toBe("same driver\n");
  });
});
