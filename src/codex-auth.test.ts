import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_AUTH_FILE_NAME,
  prepareCodexAuth,
} from "./codex-auth.js";

const auth = (lastRefresh: string, family: string): string => JSON.stringify({
  auth_mode: "chatgpt",
  last_refresh: lastRefresh,
  tokens: { refresh_token: family },
});

describe("prepareCodexAuth (#134)", () => {
  const roots: string[] = [];
  const root = async (): Promise<string> => {
    const path = await mkdtemp(join(tmpdir(), "sandbar-codex-auth-"));
    roots.push(path);
    return path;
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("seeds an absent run-owned file with private permissions", async () => {
    const stateDir = await root();
    const configuredJson = auth("2026-09-08T08:00:57Z", "new-family");
    const result = await prepareCodexAuth({ stateDir, configuredJson });
    const hostPath = join(stateDir, CODEX_AUTH_FILE_NAME);

    expect(result).toEqual({
      action: "seeded",
      mount: {
        hostPath,
        sandboxPath: "/home/agent/.codex/auth.json",
      },
    });
    expect(await readFile(hostPath, "utf8")).toBe(configuredJson);
    expect((await stat(hostPath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["newer configured value", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", "updated", "configured"],
    ["older configured value", "2026-09-03T00:00:00Z", "2026-09-02T00:00:00Z", "kept", "current"],
    ["equal configured value", "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z", "kept", "current"],
  ] as const)("orders the %s by last_refresh", async (
    _label, currentDate, configuredDate, action, survivingFamily,
  ) => {
    const stateDir = await root();
    const hostPath = join(stateDir, CODEX_AUTH_FILE_NAME);
    await writeFile(hostPath, auth(currentDate, "current"));

    const result = await prepareCodexAuth({
      stateDir,
      configuredJson: auth(configuredDate, "configured"),
      codexHome: "/var/lib/codex",
    });

    expect(result.action).toBe(action);
    expect(result.mount.sandboxPath).toBe("/var/lib/codex/auth.json");
    expect(JSON.parse(await readFile(hostPath, "utf8")).tokens.refresh_token)
      .toBe(survivingFamily);
  });

  it.each([
    ["configured malformed", "not-json", null, /CODEX_AUTH_JSON is not valid JSON/],
    ["configured undated", "{}", null, /CODEX_AUTH_JSON\.last_refresh/],
    ["configured invalid date", JSON.stringify({ last_refresh: "later" }), null, /CODEX_AUTH_JSON\.last_refresh/],
    ["current malformed", auth("2026-09-02T00:00:00Z", "configured"), "not-json", /codex-auth\.json is not valid JSON/],
    ["current undated", auth("2026-09-02T00:00:00Z", "configured"), "{}", /codex-auth\.json\.last_refresh/],
  ] as const)("refuses %s instead of guessing seed order", async (
    _label, configuredJson, currentJson, expected,
  ) => {
    const stateDir = await root();
    if (currentJson !== null) {
      await writeFile(join(stateDir, CODEX_AUTH_FILE_NAME), currentJson);
    }
    await expect(prepareCodexAuth({ stateDir, configuredJson })).rejects.toThrow(expected);
  });

  it("refuses a relative CODEX_HOME because podman mount targets are absolute", async () => {
    await expect(prepareCodexAuth({
      stateDir: await root(),
      configuredJson: auth("2026-09-02T00:00:00Z", "configured"),
      codexHome: ".codex",
    })).rejects.toThrow(/CODEX_HOME must be absolute/);
  });
});
