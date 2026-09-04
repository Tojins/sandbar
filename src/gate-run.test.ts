// #45 — what the standalone gate's reuse token covers, and what it does not.
//
// The token is the whole soundness argument for adopting a container an earlier
// invocation left running: a hash is not self-describing, so the only way its
// coverage can be a decision rather than an accident is to assert both
// directions. Every case below is either "this must tear the stack down" or
// "this must not", and each of the second kind is a warm database somebody
// would otherwise lose to an unrelated edit.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type BuiltImage,
  type GateStackConfig,
  type ResolvedGateStack,
  resolveGateStack,
} from "./config.js";
import {
  gateReuseToken,
  gateStackImagesOf,
  shouldHideWorktreeGit,
} from "./gate-run.js";

const WT = "/wt";
const V = "1.2.3";

describe("shouldHideWorktreeGit", () => {
  it("distinguishes a clone directory from a linked-worktree gitlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-gate-git-shape-"));
    try {
      const clone = join(root, "clone");
      const linked = join(root, "linked");
      await mkdir(join(clone, ".git"), { recursive: true });
      await mkdir(linked);
      await writeFile(join(linked, ".git"), "gitdir: /repo/.git/worktrees/linked\n");

      expect(shouldHideWorktreeGit(clone)).toBe(true);
      expect(shouldHideWorktreeGit(linked)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const stack = (over: Partial<GateStackConfig> = {}): ResolvedGateStack =>
  resolveGateStack({
    containers: [
      {
        name: "db",
        image: "docker.io/library/mariadb:10.11",
        lifecycle: "issue",
        env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes" },
        postReadyCommands: [["sh", "-c", "echo seed"]],
      },
      {
        name: "runner",
        image: "localhost/app:gate",
        mountWorktree: "/workspace",
        hold: true,
      },
    ],
    steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
    ...over,
  });

const token = (s: ResolvedGateStack, wt = WT, v = V): string =>
  gateReuseToken(s, wt, v);

describe("gateReuseToken", () => {
  it("is stable for the same spec, tree and version", () => {
    expect(token(stack())).toBe(token(stack()));
    expect(token(stack())).toMatch(/^[0-9a-f]{64}$/);
  });

  // Everything a reused `issue` container's creation consumed. Each of these
  // leaves a container that a since-changed config no longer describes, and the
  // reuse path would otherwise adopt it and gate against it.
  it("changes when an issue container's own spec changes", () => {
    const base = token(stack());
    const withIssue = (over: Record<string, unknown>): string =>
      token(
        stack({
          containers: [
            {
              name: "db",
              image: "docker.io/library/mariadb:10.11",
              lifecycle: "issue",
              env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes" },
              postReadyCommands: [["sh", "-c", "echo seed"]],
              ...over,
            },
            {
              name: "runner",
              image: "localhost/app:gate",
              mountWorktree: "/workspace",
              hold: true,
            },
          ] as GateStackConfig["containers"],
        }),
      );
    // The image it was created from.
    expect(withIssue({ image: "docker.io/library/mariadb:11.4" })).not.toBe(base);
    // Its environment — a database created with one password does not become a
    // database with another because the config says so.
    expect(withIssue({ env: { MYSQL_ROOT_PASSWORD: "x" } })).not.toBe(base);
    // The one that matters most, because a reused container deliberately does
    // NOT re-run these: a changed migration or seed would otherwise never run
    // at all.
    expect(
      withIssue({ postReadyCommands: [["sh", "-c", "echo seed v2"]] }),
    ).not.toBe(base);
    // Its readiness contract, its args, its mounts and its name.
    expect(
      withIssue({ readiness: { kind: "healthcheck", command: ["true"] } }),
    ).not.toBe(base);
    expect(withIssue({ args: ["--sql-mode=STRICT_TRANS_TABLES"] })).not.toBe(base);
    expect(
      withIssue({
        mounts: [{ hostPath: "fixtures/s.sql", containerPath: "/s.sql" }],
      }),
    ).not.toBe(base);
    expect(withIssue({ name: "database" })).not.toBe(base);
  });

  // Every relative `mounts` hostPath resolves against the worktree, so the same
  // spec over a different tree is a different container. (In practice the scope
  // separates them too — this is the belt to that's braces, and it is what
  // keeps the token honest if a caller ever passes a tree the scope was not
  // derived from.)
  it("changes with the worktree path", () => {
    expect(token(stack(), "/other")).not.toBe(token(stack()));
  });

  // `containerRunArgs` is sandbar's, so an upgrade that changes a flag would
  // otherwise silently adopt a container built the old way. The cost is one
  // full rebuild per upgrade, which is the right side to be wrong on.
  it("changes with sandbar's own version", () => {
    expect(token(stack(), WT, "1.2.4")).not.toBe(token(stack()));
  });

  // The other direction, and the reason the token is not just "hash the spec".
  // An `attempt` container is recreated on every gate run by definition and a
  // step is `podman exec`'d into a container it cannot have changed — folding
  // either in means renaming a lint step tears down a warm database.
  it("is unmoved by the steps and by the attempt containers", () => {
    const base = token(stack());
    expect(
      token(
        stack({
          steps: [
            { name: "lint", in: "runner", command: ["npm", "run", "lint"] },
            { name: "test", in: "runner", command: ["npm", "test"] },
          ],
        }),
      ),
    ).toBe(base);
    expect(
      token(
        stack({
          containers: [
            {
              name: "db",
              image: "docker.io/library/mariadb:10.11",
              lifecycle: "issue",
              env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes" },
              postReadyCommands: [["sh", "-c", "echo seed"]],
            },
            {
              name: "runner",
              // A different image, different mount point, no longer held: all
              // of it is recreated before the next step runs anyway.
              image: "localhost/app:other",
              mountWorktree: "/src",
              args: ["serve"],
            },
          ],
          steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
        }),
      ),
    ).toBe(base);
  });

  // A stack with no `issue` container has nothing reusable, and every such
  // stack over one tree agrees — which is harmless precisely because the reuse
  // path then finds nothing running to adopt.
  it("ignores everything when there are no issue containers", () => {
    const none = (image: string): ResolvedGateStack =>
      resolveGateStack({
        containers: [
          { name: "runner", image, mountWorktree: "/workspace", hold: true },
        ],
        steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
      });
    expect(token(none("a:1"))).toBe(token(none("b:2")));
  });
});

// The other half of what this command decides before podman is touched: which
// declared images it may build. `pulledImagesOf`'s test lives with its module;
// this one is about the asymmetry with `run.ts`, which passes `config.images`
// whole and is right to.
describe("gateStackImagesOf", () => {
  const img = (tag: string): BuiltImage => ({ tag, containerfile: "Containerfile" });

  it("keeps the entries a gateStack container runs", () => {
    expect(
      gateStackImagesOf({
        images: [img("localhost/app:gate"), img("docker.io/library/mariadb:10.11")],
        gateStack: stack(),
      }).map((i) => i.tag),
    ).toEqual(["localhost/app:gate", "docker.io/library/mariadb:10.11"]);
  });

  // The one that matters, and the one this repo's own config cannot show:
  // an agent sandbox image with its own `rebuildOn` that no container in this
  // stack runs. Unfiltered, a cold checkout builds the whole agent image before
  // the first gate container — and a failure in it stops the gate happening at
  // all, for an image the verdict does not depend on.
  it("drops an entry no gateStack container runs — the agent sandbox image", () => {
    expect(
      gateStackImagesOf({
        images: [
          img("localhost/app:gate"),
          { ...img("localhost/app:sandbar"), rebuildOn: ["package-lock.json"] },
        ],
        gateStack: stack(),
      }).map((i) => i.tag),
    ).toEqual(["localhost/app:gate"]);
  });

  // One image in both roles — sandbar's own config — is kept, since a gate
  // container does run it. The filter is about what the stack runs, never about
  // what the entry is "for".
  it("keeps an entry that is both the sandbox image and a stack container's", () => {
    expect(
      gateStackImagesOf({
        images: [img("localhost/app:gate")],
        gateStack: stack(),
      }).map((i) => i.tag),
    ).toEqual(["localhost/app:gate"]);
  });
});
