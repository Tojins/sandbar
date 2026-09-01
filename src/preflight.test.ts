import { describe, expect, it } from "vitest";
import type { ResolvedStackContainer } from "./config.js";
import {
  absoluteMountSources,
  checkInvariants,
  type ConfigStaleness,
  type RepoState,
  staleConfigWarning,
} from "./preflight.js";

const cleanState: RepoState = {
  hasGit: true,
  hasGh: true,
  hasContainerRuntime: true,
  missingImages: [],
  missingMountSources: [],
  ghAuthOk: true,
  sandboxGhTokenOk: true,
  hasAgentCredential: true,
  sourceBranch: "main",
  hasOriginBranch: true,
  unmergedIssueBranches: [],
  discardedIssueBranches: [],
  resumableIssueBranches: [],
  configuredRepo: { owner: "acme", name: "app" },
  originUrl: "https://github.com/acme/app.git",
  originRepo: { owner: "acme", name: "app" },
  originHost: "github.com",
  ghHost: "github.com",
};

function failures(s: RepoState): string[] {
  return checkInvariants(s).flatMap((r) => (r.ok ? [] : [r.message]));
}

// #34 — `gh` now names `ghOwner`/`ghRepo` on every call while `git push` still
// goes to the cache's `origin`, which is copied from the operator's checkout
// and declared by nobody. Naming the tracker cannot make the two AGREE, so
// preflight compares them; every symptom of a mismatch is silent and lands
// somewhere real (issues closed in one repo for commits pushed to another).
describe("checkInvariants — the tracker and the git remote name one repo (#34)", () => {
  it("refuses when origin points at a different repo, naming both", () => {
    const f = failures({
      ...cleanState,
      originUrl: "https://github.com/acme/app-fork.git",
      originRepo: { owner: "acme", name: "app-fork" },
    });
    const msg = f.find((m) => m.includes("ghOwner/ghRepo"));
    expect(msg).toBeDefined();
    expect(msg).toContain("acme/app");
    expect(msg).toContain("acme/app-fork");
    // The URL itself, because "origin is acme/app-fork" is not actionable
    // without knowing which remote said so.
    expect(msg).toContain("https://github.com/acme/app-fork.git");
  });

  // GitHub owner and repo names are case-insensitive and `gh` follows a
  // case-differing --repo without complaint, so refusing here would be
  // refusing a working configuration.
  it("accepts a case difference", () => {
    expect(
      failures({
        ...cleanState,
        originUrl: "git@github.com:ACME/App.git",
        originRepo: { owner: "ACME", name: "App" },
      }),
    ).toEqual([]);
  });

  // A URL `parseRepoFromRemoteUrl` will not commit to (a local mirror, most
  // likely) is reported by runPreflight as a warning, not turned into a guess
  // here: a wrong parse REFUSES a working configuration, which is worse than
  // the split it is trying to catch.
  it("stays silent when origin could not be read as a repo", () => {
    expect(
      failures({
        ...cleanState,
        originUrl: "/srv/git/app.git",
        originRepo: null,
      }),
    ).toEqual([]);
  });

  it("stays silent when there is no origin URL at all", () => {
    expect(
      failures({
        ...cleanState,
        originUrl: null,
        originRepo: null,
        originHost: null,
      }),
    ).toEqual([]);
  });
});

// The HOST half, and it is a separate invariant because a matching owner/name
// on a different host is the WORSE failure: it passes the owner/name comparison
// while every tracker call goes to an unrelated repository that happens to
// share a name. `gh`'s flag is `[HOST/]OWNER/REPO` and `repoSlug` emits the
// two-part form, so the host is always gh's default.
describe("checkInvariants — the tracker host (#34)", () => {
  it("refuses a GHE origin while gh would go to github.com", () => {
    const f = failures({
      ...cleanState,
      originUrl: "https://github.acme-corp.com/acme/app.git",
      originHost: "github.acme-corp.com",
      // Deliberately AGREEING on owner/name: without this check the run
      // proceeds, and every issue read and write lands on
      // github.com/acme/app, an unrelated repository that happens to match.
      originRepo: { owner: "acme", name: "app" },
    });
    const msg = f.find((m) => m.includes("github.acme-corp.com"));
    expect(msg).toBeDefined();
    expect(msg).toContain("github.com");
    // The message has to name gh's own mechanism, since the config has no
    // host field to fix instead.
    expect(msg).toContain("GH_HOST");
  });

  it("accepts a GHE origin when gh is pointed at that instance", () => {
    expect(
      failures({
        ...cleanState,
        originUrl: "https://github.acme-corp.com/acme/app.git",
        originHost: "github.acme-corp.com",
        ghHost: "github.acme-corp.com",
      }),
    ).toEqual([]);
  });

  // An `insteadOf` alias has no readable host. Refusing over one sandbar
  // invented is the same false-refusal failure the parser exists to avoid.
  it("stays silent when the host could not be read", () => {
    expect(
      failures({
        ...cleanState,
        originUrl: "ghalias:acme/app",
        originHost: null,
      }),
    ).toEqual([]);
  });
});

describe("checkInvariants", () => {
  it("passes on a fully clean state", () => {
    expect(failures(cleanState)).toEqual([]);
  });

  it("flags missing git", () => {
    const f = failures({ ...cleanState, hasGit: false });
    expect(f.some((m) => m.includes("`git` is not on PATH"))).toBe(true);
  });

  it("flags missing gh", () => {
    const f = failures({ ...cleanState, hasGh: false });
    expect(f.some((m) => m.includes("`gh` is not on PATH"))).toBe(true);
  });

  it("flags missing container runtime", () => {
    const f = failures({ ...cleanState, hasContainerRuntime: false });
    expect(f.some((m) => m.includes("podman") && m.includes("PATH"))).toBe(true);
  });

  // The referenced-but-not-built images (#24 D7). Preflight refuses rather than
  // pulling, so the message has to be the pull command itself — an operator who
  // has to go and derive it from config is the failure mode this replaces.
  it("flags every missing gate-stack image with the exact pull command", () => {
    const f = failures({
      ...cleanState,
      missingImages: ["docker.io/library/mariadb:10.11", "docker.io/mailhog/mailhog:latest"],
    });
    const msg = f.find((m) => m.includes("gate-stack image"));
    expect(msg).toBeDefined();
    expect(msg).toContain("podman pull docker.io/library/mariadb:10.11");
    expect(msg).toContain("podman pull docker.io/mailhog/mailhog:latest");
    expect(msg).toContain("2 gate-stack image(s)");
  });

  it("flags failed gh auth", () => {
    const f = failures({ ...cleanState, ghAuthOk: false });
    expect(f.some((m) => m.includes("gh auth status"))).toBe(true);
  });

  // Names `config.env` rather than a file path (#38): sandbar no longer knows
  // where the value came from, so pointing at a path it invented would send the
  // operator to a file they may not have.
  it("flags an invalid sandbox GH_TOKEN (points at config.env)", () => {
    const f = failures({ ...cleanState, sandboxGhTokenOk: false });
    expect(
      f.some(
        (m) =>
          m.includes("GH_TOKEN") &&
          m.includes("config.env") &&
          m.includes("rejected by GitHub"),
      ),
    ).toBe(true);
  });

  it("flags missing agent credential and names both env-var options", () => {
    const f = failures({ ...cleanState, hasAgentCredential: false });
    expect(
      f.some(
        (m) =>
          m.includes("CLAUDE_CODE_OAUTH_TOKEN") &&
          m.includes("ANTHROPIC_API_KEY"),
      ),
    ).toBe(true);
  });

  // The operator-state invariants ("not on <sourceBranch>", "an in-progress
  // merge/rebase was detected") are GONE, not moved (#38 item 7). They existed
  // only because a human might be standing in the directory sandbar operated
  // on. Against the bare cache they are vacuous; pointed at `config.cwd` they
  // would fail runs because the operator is mid-rebase in their own repo.
  it("says nothing about the operator's branch or in-progress operations", () => {
    const f = failures(cleanState);
    expect(f).toEqual([]);
    const all = checkInvariants({ ...cleanState, hasOriginBranch: false })
      .flatMap((r) => (r.ok ? [] : [r.message]))
      .join("\n");
    expect(all).not.toMatch(/MERGE_HEAD|rebase|Not on/);
  });

  it("flags missing origin/<sourceBranch>", () => {
    const f = failures({ ...cleanState, hasOriginBranch: false });
    expect(f.some((m) => m.includes("origin/main"))).toBe(true);
  });

  it("flags unmerged issue branches and lists each one", () => {
    const f = failures({
      ...cleanState,
      unmergedIssueBranches: [
        "sandbar/issue-42-foo",
        "sandbar/issue-43-bar",
      ],
    });
    expect(f.length).toBe(1);
    expect(f[0]).toContain("sandbar/issue-42-foo");
    expect(f[0]).toContain("sandbar/issue-43-bar");
    expect(f[0]).toContain("git branch -D");
  });

  it("flags discarded issue branches separately from unmerged ones", () => {
    const f = failures({
      ...cleanState,
      unmergedIssueBranches: ["sandbar/issue-42-foo"],
      discardedIssueBranches: ["sandbar/issue-43-bar"],
    });
    expect(f.length).toBe(2);
    const unmergedMsg = f.find((m) => m.includes("Unmerged"));
    const discardedMsg = f.find((m) => m.includes("Discarded"));
    expect(unmergedMsg).toBeDefined();
    expect(unmergedMsg).toContain("sandbar/issue-42-foo");
    expect(unmergedMsg).not.toContain("sandbar/issue-43-bar");
    expect(discardedMsg).toBeDefined();
    expect(discardedMsg).toContain("sandbar/issue-43-bar");
    expect(discardedMsg).toContain("remote deleted");
    expect(discardedMsg).toContain("git branch -D");
  });

  it("does not flag resumable issue branches (open + queued → resumed, not refused)", () => {
    // #13: stranded work from an interrupted run is handed back to the normal
    // loop, so its branch must not be a hard pre-flight error.
    const f = failures({
      ...cleanState,
      resumableIssueBranches: ["sandbar/issue-296-keyword-escape"],
    });
    expect(f).toEqual([]);
  });

  it("flags genuinely-unmerged branches but not resumable ones alongside them", () => {
    const f = failures({
      ...cleanState,
      unmergedIssueBranches: ["sandbar/issue-99-stale"],
      resumableIssueBranches: ["sandbar/issue-296-keyword-escape"],
    });
    expect(f.length).toBe(1);
    expect(f[0]).toContain("sandbar/issue-99-stale");
    expect(f[0]).not.toContain("sandbar/issue-296-keyword-escape");
  });

  it("returns multiple distinct failures when several invariants fail", () => {
    const f = failures({
      ...cleanState,
      hasGh: false,
      hasOriginBranch: false,
      hasAgentCredential: false,
    });
    expect(f.length).toBe(3);
  });

  it("error messages are operator-actionable (mention what to run/check)", () => {
    const broken: RepoState = {
      ...cleanState,
      hasGh: false,
      hasContainerRuntime: false,
      missingImages: ["docker.io/library/mariadb:10.11"],
      ghAuthOk: false,
      sandboxGhTokenOk: false,
      hasAgentCredential: false,
      hasOriginBranch: false,
      unmergedIssueBranches: ["sandbar/issue-1-x"],
    };
    const f = failures(broken);
    for (const msg of f) {
      expect(msg).toMatch(
        /git|gh|origin|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|Resolve|Switch|Install|stash|Configure|build|pull/,
      );
    }
  });
});

// #51 — a gate-stack `mounts[].hostPath` that does not exist on the host fails
// `podman run` at bringup, and a gate container is `attempt`-lifecycle, so #24
// D5 charges that to the BRANCH: a gate red about a statfs source no agent can
// see or fix, repeated until the attempt budget parks the issue as
// `agent-stuck` with an "environment" trace. Host state belongs in preflight,
// beside `missingImages`, which is the identical class.
describe("checkInvariants — gate-stack mount sources exist (#51)", () => {
  // The path AND the container, because a stack with several containers
  // otherwise leaves the operator grepping their config for the declaration.
  it("names the path and the container that declares it", () => {
    const f = failures({
      ...cleanState,
      missingMountSources: [
        {
          container: "gate",
          hostPath: "/run/user/1000/podman/podman.sock",
          detail: "no such file or directory",
        },
      ],
    });

    const msg = f.find((m) => m.includes("mount source"));
    expect(msg).toBeDefined();
    expect(msg).toContain("/run/user/1000/podman/podman.sock");
    expect(msg).toContain("gate");
    expect(msg).toContain("no such file or directory");
    // The operator has to be told this is theirs to fix, not the branch's —
    // that misattribution is the whole reason the check exists.
    expect(msg).toContain("config.gateStack");
  });

  it("lists every missing source, not just the first", () => {
    const f = failures({
      ...cleanState,
      missingMountSources: [
        { container: "gate", hostPath: "/a", detail: "no such file or directory" },
        { container: "db", hostPath: "/b", detail: "EACCES" },
      ],
    });

    const msg = f.find((m) => m.includes("mount source"));
    expect(msg).toContain("/a");
    expect(msg).toContain("/b");
    expect(msg).toContain("db");
  });
});

const container = (
  name: string,
  mounts: ReadonlyArray<{ hostPath: string; containerPath: string }>,
): ResolvedStackContainer => ({
  name,
  image: "img",
  lifecycle: "attempt",
  env: {},
  args: [],
  mounts: mounts.map((m) => ({ ...m, mode: "ro" as const })),
  mountWorktree: "/workspace",
  servesWorktree: false,
  inSandbox: false,
  hold: false,
  readiness: null,
  readinessTimeoutMs: 60_000,
  postReadyCommands: [],
});

describe("absoluteMountSources (#51)", () => {
  it("collects absolute hostPaths with the container that declares them", () => {
    expect(
      absoluteMountSources([
        container("gate", [{ hostPath: "/srv/fixtures", containerPath: "/fx" }]),
        container("db", [{ hostPath: "/var/lib/seed", containerPath: "/seed" }]),
      ]),
    ).toEqual([
      { container: "gate", hostPath: "/srv/fixtures" },
      { container: "db", hostPath: "/var/lib/seed" },
    ]);
  });

  // The gap this check cannot close, pinned so nobody "fixes" it into a
  // preflight that refuses on every relative mount: a relative hostPath
  // resolves against the worktree being gated, which does not exist yet.
  it("ignores relative hostPaths, which name a tree that does not exist yet", () => {
    expect(
      absoluteMountSources([
        container("gate", [
          { hostPath: "fixtures/db.sql", containerPath: "/fx/db.sql" },
          { hostPath: "../shared", containerPath: "/shared" },
          { hostPath: "/etc/ssl/certs", containerPath: "/certs" },
        ]),
      ]),
    ).toEqual([{ container: "gate", hostPath: "/etc/ssl/certs" }]);
  });

  it("is empty for a stack that mounts nothing but the worktree", () => {
    expect(absoluteMountSources([container("gate", [])])).toEqual([]);
  });
});

// #66 — the launcher no longer pulls, so the config file the run imported is
// whatever the checkout holds, for as long as the operator leaves it there.
describe("staleConfigWarning — a landed config change that never arrived (#66)", () => {
  const stale = (over: Partial<ConfigStaleness> = {}): ConfigStaleness => ({
    configPath: "/home/op/app/sandbar.config.mjs",
    sourceBranch: "main",
    hostCwd: "/home/op/app",
    behind: 4,
    touchingConfig: 1,
    ...over,
  });

  it("names the file, both counts and what to do about it", () => {
    const message = staleConfigWarning(stale());
    expect(message).toContain("/home/op/app/sandbar.config.mjs");
    expect(message).toContain("4 commit(s) behind origin/main");
    expect(message).toContain("1 of them change");
    expect(message).toMatch(/gate stack/);
    expect(message).toMatch(/Pull, then relaunch/);
  });

  // The narrowing that keeps it readable: after a landing the checkout is
  // behind by construction, and a warning that fires on every relaunch teaches
  // an operator to ignore the one that matters.
  it("says nothing when the missing commits leave the config alone", () => {
    expect(staleConfigWarning(stale({ touchingConfig: 0 }))).toBeNull();
  });

  it("says nothing when the checkout is level with origin", () => {
    expect(
      staleConfigWarning(stale({ behind: 0, touchingConfig: 0 })),
    ).toBeNull();
  });

  // A programmatic host passed an object, so there is no file to name and
  // nothing for them to pull.
  it("says nothing when the run has no config file", () => {
    expect(
      staleConfigWarning(stale({ configPath: null, touchingConfig: 0 })),
    ).toBeNull();
  });
});
