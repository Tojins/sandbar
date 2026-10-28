// The deployment channel's request file (#146).
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RESTART_REQUEST_FILE,
  clearRestartRequest,
  parseRestartRequest,
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

  // The play's second line: a `Sandbar-Restart: now` trailer in what it
  // applied, which drains at once instead of waiting out `restartDeferMs`.
  it.each([
    ["the commit alone", "abc1234\n", false],
    ["an urgent line", "abc1234\nurgent\n", true],
    ["an urgent line with stray whitespace", "abc1234\r\n  urgent \r\n", true],
    ["urgent as the commit line", "urgent\n", false],
    ["another second line", "abc1234\napplied 2026-09-11\n", false],
  ])("reads urgency from %s", (_name, contents, urgent) => {
    expect(parseRestartRequest(contents).urgent).toBe(urgent);
  });

  it("clears an urgent request by the commit it names", async () => {
    await writeFile(path, "abc1234\nurgent\n");
    await expect(readRestartRequest(path)).resolves.toEqual({ detail: "abc1234", urgent: true });
    await expect(clearRestartRequest(path, "abc1234")).resolves.toBe(true);
  });

  it("reads no request when the file is absent", async () => {
    await expect(readRestartRequest(path)).resolves.toBeNull();
    await expect(clearRestartRequest(path, "abc1234")).resolves.toBe(false);
  });

  it("reads the pending request without consuming it", async () => {
    await writeFile(path, "abc1234\n");
    const pending = { detail: "abc1234", urgent: false };
    await expect(readRestartRequest(path)).resolves.toEqual(pending);
    await expect(readRestartRequest(path)).resolves.toEqual(pending);
    await expect(readFile(path, "utf8")).resolves.toBe("abc1234\n");
  });

  // The startup clear is what keeps the restart exit unrepeatable: the unit
  // turns that code back into a start, so a request that survived the restart
  // would drain the new process straight back out.
  it("clears the request the caller was started to answer", async () => {
    await writeFile(path, "abc1234\n");
    await expect(clearRestartRequest(path, "abc1234")).resolves.toBe(true);
    await expect(readRestartRequest(path)).resolves.toBeNull();
  });

  // The one this process is NOT the answer to. A startup spends minutes in
  // preflight and image builds while the box converges every five, so a request
  // for the next commit — a revert, in the case that matters — has to outlive
  // the clear and reach the first recompute.
  it.each([
    ["a newer commit", "def5678\n"],
    ["a request with nothing readable in it", "\n"],
  ])("leaves a request rewritten since as %s", async (_name, rewritten) => {
    await writeFile(path, "abc1234\n");
    await expect(readRestartRequest(path)).resolves.toMatchObject({ detail: "abc1234" });
    await writeFile(path, rewritten);
    await expect(clearRestartRequest(path, "abc1234")).resolves.toBe(false);
    await expect(readFile(path, "utf8")).resolves.toBe(rewritten);
  });

  it("propagates a read that is not an absent file", async () => {
    await expect(readRestartRequest(dir)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
