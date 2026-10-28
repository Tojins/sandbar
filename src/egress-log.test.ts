import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLogFrom } from "./egress.js";

describe("readLogFrom", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sandbar-egress-log-"));
    path = join(dir, "log.jsonl");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("leaves an incomplete trailing line unread until its newline arrives", async () => {
    await writeFile(path, "a\nb");
    const first = await readLogFrom(path, 0);
    expect(first).toEqual({ lines: ["a"], end: 2 });
    await appendFile(path, "c\n");
    expect(await readLogFrom(path, first.end)).toEqual({ lines: ["bc"], end: 5 });
  });

  it("does not return lines already read", async () => {
    await writeFile(path, "a\nb\n");
    const first = await readLogFrom(path, 0);
    expect(first.lines).toEqual(["a", "b"]);
    expect(await readLogFrom(path, first.end)).toEqual({ lines: [], end: first.end });
    await appendFile(path, "c\n");
    expect((await readLogFrom(path, first.end)).lines).toEqual(["c"]);
  });
});
