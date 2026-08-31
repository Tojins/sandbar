// The create-or-update PR primitive (#62). Argv, because argv is where the
// bugs in a shell-out layer live and no fake adapter can see it.
import { describe, expect, it } from "vitest";

import { type PrExec, ensurePullRequest } from "./forge-pr.js";

type Call = { file: string; args: string[]; cwd: string | undefined };

function fakeExec(
  handler: (call: Call) => { stdout?: string } | Error,
): { exec: PrExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: PrExec = async (file, args, opts) => {
    const call = { file, args: [...args], cwd: opts?.cwd };
    calls.push(call);
    const r = handler(call);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

const args = {
  cwd: "/wt",
  repoFlag: "acme/app",
  head: "sandbar/chunk-42-c",
  base: "main",
  title: "T",
  body: "B",
};

const flag = (argv: readonly string[], name: string): string | undefined =>
  argv.indexOf(name) < 0 ? undefined : argv[argv.indexOf(name) + 1];

describe("ensurePullRequest", () => {
  it("looks for the OPEN PR on this head→base pair, in the named repo", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "[]" }));
    await ensurePullRequest({ ...args, exec });

    const list = calls[0]!.args;
    expect(list.slice(0, 2)).toEqual(["pr", "list"]);
    expect(flag(list, "--repo")).toBe("acme/app");
    expect(flag(list, "--head")).toBe("sandbar/chunk-42-c");
    expect(flag(list, "--base")).toBe("main");
    expect(flag(list, "--state")).toBe("open");
    expect(calls[0]!.cwd).toBe("/wt");
  });

  it("creates as a DRAFT when asked, and parses the number out of the URL", async () => {
    const { exec, calls } = fakeExec((c) =>
      c.args[1] === "list"
        ? { stdout: "[]" }
        : { stdout: "https://github.com/acme/app/pull/77\n" },
    );
    const pr = await ensurePullRequest({ ...args, draft: true, exec });

    expect(pr).toEqual({
      number: 77,
      url: "https://github.com/acme/app/pull/77",
    });
    const create = calls[1]!.args;
    expect(create.slice(0, 2)).toEqual(["pr", "create"]);
    expect(create).toContain("--draft");
    expect(flag(create, "--head")).toBe("sandbar/chunk-42-c");
    expect(flag(create, "--base")).toBe("main");
    expect(flag(create, "--title")).toBe("T");
    expect(flag(create, "--body")).toBe("B");
  });

  it("creates a plain PR when draft is not asked for", async () => {
    const { exec, calls } = fakeExec((c) =>
      c.args[1] === "list" ? { stdout: "[]" } : { stdout: "u/pull/1" },
    );
    await ensurePullRequest({ ...args, exec });

    expect(calls[1]!.args).not.toContain("--draft");
  });

  it("re-titles and re-bodies a survivor instead of creating a second PR", async () => {
    // The whole reason this is create-or-UPDATE: a PR describing the state it
    // had one cycle ago is a wrong record of what its branch carries.
    const { exec, calls } = fakeExec((c) =>
      c.args[1] === "list"
        ? { stdout: JSON.stringify([{ number: 42, url: "u42" }]) }
        : {},
    );
    const pr = await ensurePullRequest({
      ...args,
      title: "T2",
      body: "B2",
      exec,
    });

    expect(pr).toEqual({ number: 42, url: "u42" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.slice(0, 3)).toEqual(["pr", "edit", "42"]);
    expect(flag(calls[1]!.args, "--title")).toBe("T2");
    expect(flag(calls[1]!.args, "--body")).toBe("B2");
  });

  it("never re-drafts an existing PR, even when the caller asked for a draft", async () => {
    // A human who marked the chunk PR ready for review made a deliberate
    // two-step decision (#54 Q14). Flipping it back on the next cycle would
    // fight them silently; reconciliation is #64's job, not this function's.
    const { exec, calls } = fakeExec((c) =>
      c.args[1] === "list"
        ? { stdout: JSON.stringify([{ number: 42, url: "u42" }]) }
        : {},
    );
    await ensurePullRequest({ ...args, draft: true, exec });

    expect(calls[1]!.args.slice(0, 2)).toEqual(["pr", "edit"]);
    expect(calls.flatMap((c) => c.args)).not.toContain("--draft");
    expect(calls.flatMap((c) => c.args)).not.toContain("--ready");
  });

  it("does not try to edit a listed PR it could not read a number out of", async () => {
    // Better a PR with no handle than `gh pr edit NaN`, which would either
    // fail or, worse, edit something else.
    const { exec, calls } = fakeExec((c) =>
      c.args[1] === "list"
        ? { stdout: JSON.stringify([{ url: "u" }]) }
        : { stdout: "" },
    );
    const pr = await ensurePullRequest({ ...args, exec });

    expect(pr).toEqual({ number: 0, url: "u" });
    expect(calls).toHaveLength(1);
  });

  it("treats an empty listing response as no PR rather than throwing", async () => {
    const { exec } = fakeExec((c) =>
      c.args[1] === "list" ? { stdout: "  \n" } : { stdout: "x/pull/9" },
    );
    expect((await ensurePullRequest({ ...args, exec })).number).toBe(9);
  });

  it("reports a PR it created but could not parse as number 0", async () => {
    const { exec } = fakeExec((c) =>
      c.args[1] === "list" ? { stdout: "[]" } : { stdout: "Warning: something" },
    );
    expect(await ensurePullRequest({ ...args, exec })).toEqual({
      number: 0,
      url: "Warning: something",
    });
  });
});
