// #57 — the argv of the lane-override notice, and its one-per-issue rule.
//
// Same reasoning as gh-argv.test.ts: this call posts a comment on a human's
// issue, so "which repository" being wrong is a comment nobody reads, and a
// fake satisfies the contract no matter what argv the real call builds. It is
// also the one gh call in sandbar that is deliberately BEST-EFFORT, and a
// swallow that swallowed too much (a thrown error taking the cycle down, or a
// missing marker check spraying a comment per cycle onto a held issue) is
// exactly what a fake would not show.
//
// Driven through a `gh` shim on PATH that records its own argv and answers
// `issue view --json comments` from an env var, so the "already told" branch is
// stated as the tracker state it really is.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LANE_OVERRIDE_COMMENT,
  LANE_OVERRIDE_MARKER,
  postLaneOverrideNotices,
} from "./lanes.js";

const REPO = { owner: "acme", name: "app" };

describe("postLaneOverrideNotices", () => {
  let shimBin: string;
  let argvLog: string;
  let originalPath: string | undefined;

  const calls = async (): Promise<string[][]> => {
    const raw = await readFile(argvLog, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string[]);
  };

  const repoFlagOf = (argv: readonly string[]): string | undefined => {
    const i = argv.indexOf("--repo");
    return i < 0 ? undefined : argv[i + 1];
  };

  const bodyOf = (argv: readonly string[]): string | undefined => {
    const i = argv.indexOf("--body");
    return i < 0 ? undefined : argv[i + 1];
  };

  const commentCalls = async (): Promise<string[][]> =>
    (await calls()).filter((argv) => argv[1] === "comment");

  beforeEach(async () => {
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-lanegh-"));
    argvLog = join(shimBin, "argv.jsonl");
    await writeFile(argvLog, "");
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        `log='${argvLog}'`,
        'printf "[" >> "$log"',
        'sep=""',
        'for a in "$@"; do',
        // The body is multi-line prose; JSON-escaping it in sh is not worth it,
        // and no assertion here needs its newlines. Recorded with newlines
        // flattened to spaces so the log stays one JSON array per line.
        '  esc=$(printf "%s" "$a" | tr "\\n" " " | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\')',
        '  printf \'%s"%s"\' "$sep" "$esc" >> "$log"',
        '  sep=","',
        "done",
        'printf "]\\n" >> "$log"',
        '[ -n "$SANDBAR_TEST_GH_FAIL" ] && exit 1',
        'case "$*" in',
        '  *--json*comments*) printf "%s" "${SANDBAR_TEST_COMMENTS:-{\\"comments\\":[]}}" ;;',
        "esac",
        "exit 0",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    delete process.env["SANDBAR_TEST_COMMENTS"];
    delete process.env["SANDBAR_TEST_GH_FAIL"];
    await rm(shimBin, { recursive: true, force: true });
  });

  it("posts the notice to the configured repo, naming the blocker", async () => {
    const posted = await postLaneOverrideNotices(REPO, [
      { issue: 42, gatedBy: 7 },
    ]);

    expect(posted).toEqual([42]);
    const [argv] = await commentCalls();
    expect(argv?.slice(0, 3)).toEqual(["issue", "comment", "42"]);
    expect(repoFlagOf(argv ?? [])).toBe("acme/app");
    expect(bodyOf(argv ?? [])).toContain("#7");
    expect(bodyOf(argv ?? [])).toContain(LANE_OVERRIDE_MARKER);
  });

  it("reads the issue's existing comments from the same repo first", async () => {
    await postLaneOverrideNotices(REPO, [{ issue: 42, gatedBy: 7 }]);

    const [read] = await calls();
    expect(read?.slice(0, 3)).toEqual(["issue", "view", "42"]);
    expect(repoFlagOf(read ?? [])).toBe("acme/app");
    expect(read).toContain("comments");
  });

  it("says nothing on an issue already carrying the marker", async () => {
    // A review-gated issue keeps `ready-for-agent` and is a candidate again
    // every cycle of every run, so this is the difference between one comment
    // and one per cycle forever.
    process.env["SANDBAR_TEST_COMMENTS"] = JSON.stringify({
      comments: [{ body: "unrelated" }, { body: LANE_OVERRIDE_COMMENT(7) }],
    });

    const posted = await postLaneOverrideNotices(REPO, [
      { issue: 42, gatedBy: 7 },
    ]);

    expect(posted).toEqual([]);
    expect(await commentCalls()).toEqual([]);
  });

  it("posts one notice per overridden issue", async () => {
    const posted = await postLaneOverrideNotices(REPO, [
      { issue: 42, gatedBy: 7 },
      { issue: 43, gatedBy: 42 },
    ]);

    expect(posted).toEqual([42, 43]);
    expect((await commentCalls()).map((argv) => argv[2])).toEqual(["42", "43"]);
  });

  it("does not throw when gh fails — the fact is still true next cycle", async () => {
    process.env["SANDBAR_TEST_GH_FAIL"] = "1";

    const posted = await postLaneOverrideNotices(REPO, [
      { issue: 42, gatedBy: 7 },
    ]);

    expect(posted).toEqual([]);
  });

  it("keeps going for the other issues when one fails", async () => {
    // The shim fails only for #42: a per-issue catch, not a per-batch one.
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        `log='${argvLog}'`,
        'case "$*" in *" 42 "*|*" 42") exit 1 ;; esac',
        'printf \'["%s","%s","%s"]\\n\' "$1" "$2" "$3" >> "$log"',
        'case "$*" in',
        '  *--json*comments*) printf \'{"comments":[]}\' ;;',
        "esac",
        "exit 0",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const posted = await postLaneOverrideNotices(REPO, [
      { issue: 42, gatedBy: 7 },
      { issue: 43, gatedBy: 7 },
    ]);

    expect(posted).toEqual([43]);
  });
});
