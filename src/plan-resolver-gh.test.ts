// #34 — `gh issue list` resolves the repo from the git remotes of the directory
// it runs in, so the planner's queue is a property of that directory. It used
// to inherit `process.cwd()`, which made the backlog sandbar worked a function
// of where the host process was launched rather than of `config.cwd`.
//
// Pinned through a `gh` shim on PATH that echoes its own working directory, so
// the assertion covers the whole chain down to `execFile` rather than the
// argument list of a fake. `fetchIssueStates` is deliberately not covered: it
// names the repo in its GraphQL variables and has never been cwd-sensitive.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchCandidates } from "./plan-resolver.js";

describe("fetchCandidates runs gh in the given cwd (#34)", () => {
  let shimBin: string;
  let elsewhere: string;
  let target: string;
  let originalCwd: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
    // Reports the directory gh was invoked in, in the shape `gh issue list
    // --json number,title,body,labels` returns.
    await writeFile(
      join(shimBin, "gh"),
      '#!/bin/sh\nprintf \'[{"number":1,"title":"%s","body":"","labels":[]}]\' "$PWD"\n',
      { mode: 0o755 },
    );
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;

    elsewhere = await mkdtemp(join(tmpdir(), "sandbar-launch-"));
    target = await mkdtemp(join(tmpdir(), "sandbar-target-"));
    process.chdir(elsewhere);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(shimBin, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it("asks the tracker of the configured repo, not of the launch directory", async () => {
    const candidates = await fetchCandidates(target);

    expect(candidates[0]?.title).toBe(realpathSync(target));
    expect(candidates[0]?.title).not.toBe(realpathSync(elsewhere));
  });
});
