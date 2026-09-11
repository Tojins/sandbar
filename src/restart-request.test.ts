// The deployment channel's request file (#146).
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RESTART_REQUEST_FILE,
  clearRestartRequest,
  readRestartRequest,
  restartRequestDetail,
  restartRequestPath,
} from "./restart-request.js";

describe("restart request (#146)", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sandbar-restart-"));
    path = restartRequestPath(join(dir, "sandbar.config.mjs"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("sits beside the config file the daemon was started with", () => {
    expect(restartRequestPath("/home/sandbar/installation/sandbar.config.mjs"))
      .toBe(`/home/sandbar/installation/${RESTART_REQUEST_FILE}`);
  });

  it.each([
    ["a trailing newline", "abc1234\n", "abc1234"],
    ["surrounding blank lines", "\n  abc1234  \n\n", "abc1234"],
    ["more than the play writes", "abc1234\napplied 2026-09-11\n", "abc1234"],
    ["nothing readable", "  \n", "no commit recorded"],
  ])("names what the request carried: %s", (_name, contents, detail) => {
    expect(restartRequestDetail(contents)).toBe(detail);
  });

  it("reads no request when the file is absent", async () => {
    await expect(readRestartRequest(path)).resolves.toBeNull();
    await expect(clearRestartRequest(path)).resolves.toBeNull();
  });

  it("reads the pending request without consuming it", async () => {
    await writeFile(path, "abc1234\n");
    await expect(readRestartRequest(path)).resolves.toBe("abc1234");
    await expect(readRestartRequest(path)).resolves.toBe("abc1234");
    await expect(readFile(path, "utf8")).resolves.toBe("abc1234\n");
  });

  // The startup clear is what keeps the restart exit unrepeatable: the unit
  // turns that code back into a start, so a request that survived the restart
  // would drain the new process straight back out.
  it("clears a pending request and reports what it cleared", async () => {
    await writeFile(path, "abc1234\n");
    await expect(clearRestartRequest(path)).resolves.toBe("abc1234");
    await expect(readRestartRequest(path)).resolves.toBeNull();
  });

  it("propagates a read that is not an absent file", async () => {
    await expect(readRestartRequest(dir)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
