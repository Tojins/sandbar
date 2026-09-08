import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  start: vi.fn(async () => ({
    url: "http://127.0.0.1:7444/",
    close: vi.fn(async () => undefined),
  })),
  cleanup: vi.fn(),
  install: vi.fn(),
}));

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  resolveConfig: vi.fn((config: object) => ({
    ...config,
    cwd: "/resolved/repo",
    workDir: ".state",
    uiPort: 7444,
  })),
}));
vi.mock("./repo-cache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./repo-cache.js")>(),
  repoLayout: vi.fn(() => ({ logsDir: "/resolved/repo/.state/logs" })),
}));
vi.mock("./ui-server.js", () => ({ startUiServer: seams.start }));
vi.mock("./cleanup.js", () => ({
  installCleanupTraps: seams.install,
  onCleanup: seams.cleanup,
}));

import { main } from "./cli.js";

describe("sandbar ui entrypoint", () => {
  it("loads config relative to the invocation cwd, serves, prints, and registers close", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sandbar-cli-ui-"));
    await writeFile(join(cwd, "other.mjs"), "export default { marker: 'loaded' };\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["ui", "--config", "other.mjs"], cwd)).resolves.toBe(0);
    expect(seams.start).toHaveBeenCalledWith({
      logsDir: "/resolved/repo/.state/logs",
      port: 7444,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:7444/");
    expect(seams.install).toHaveBeenCalledOnce();
    expect(seams.cleanup).toHaveBeenCalledOnce();
    const close = seams.cleanup.mock.calls[0]?.[0];
    await close();
    expect((await seams.start.mock.results[0]?.value).close).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("uses the invocation port instead of config.uiPort when supplied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sandbar-cli-ui-"));
    await writeFile(join(cwd, "sandbar.config.mjs"), "export default {};\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["ui", "--port", "7555"], cwd)).resolves.toBe(0);
    expect(seams.start).toHaveBeenLastCalledWith({
      logsDir: "/resolved/repo/.state/logs",
      port: 7555,
    });
    log.mockRestore();
  });
});
