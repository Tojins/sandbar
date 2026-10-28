// #195 decision 2 — after the process guard, nothing `replay run` spawns holds
// a forge credential, and a `gh` reached through PATH refuses.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { FORGE_CREDENTIAL_KEYS } from "./replay.js";
import { GH_DISABLED_EXIT, guardReplayProcess } from "./replay-run.js";

const exec = promisify(execFile);
const saved = { ...process.env };
const dirs: string[] = [];

afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("guardReplayProcess (#195)", () => {
  it("strips the forge credentials, empties GH_CONFIG_DIR and disables gh", async () => {
    const replayDir = await mkdtemp(join(tmpdir(), "sandbar-replay-guard-"));
    dirs.push(replayDir);
    for (const key of FORGE_CREDENTIAL_KEYS) process.env[key] = "secret";

    await guardReplayProcess(replayDir);

    expect(FORGE_CREDENTIAL_KEYS.filter((key) => key in process.env)).toEqual([]);
    const ghConfigDir = process.env.GH_CONFIG_DIR;
    expect(ghConfigDir).toBe(join(replayDir, "gh-config"));
    expect(await readdir(ghConfigDir as string)).toEqual([]);
    const gh = exec("gh", ["issue", "comment", "1", "--body", "x"]);
    await expect(gh).rejects.toMatchObject({
      code: GH_DISABLED_EXIT,
      stderr: "sandbar replay: gh is disabled\n",
    });
  });
});
