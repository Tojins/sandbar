// What PODMAN defines about the input-fingerprint label (#37), asserted by
// running podman — the same argument gate-stack-podman.test.ts and
// forge-verify-git.test.ts make. `buildArgv` proves sandbar emits the `--label`
// it means to and `parseInputsLabel` proves it can read the shape podman
// documents; neither can prove the value survives a build and comes back out of
// `image inspect`, and the whole staleness decision rests on that round trip.
//
// If it did not survive, `ensureImages` would read null every time and rebuild
// every declared image on every run — the loud failure. The silent one is the
// mirror: a fingerprint that came back stale-but-parseable would pin a gate to
// an image the operator's own checkout no longer matches.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, it } from "vitest";

import type { BuiltImage } from "./config.js";
import { AGENT_PROVIDER_PACKAGES } from "./agent-providers.js";
import {
  agentToolsContainerfile,
  detectImageLibc,
} from "./agent-tools.js";
import {
  ImageBuildError,
  buildImage,
  ensureImages,
  readInputsLabel,
  sweepBranchImages,
} from "./ensure-images.js";
import { variantImageTag } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  type FinishedHook,
  podmanTestScope,
} from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const BASE = "docker.io/library/mariadb:10.11";

// Per PROCESS, not per file (#47). The pod collision the issue names is not
// even the worst half here: tests rebuild their tags, so with one hardcoded
// tag concurrent bodies destroy and
// rebuild each other's fixture image mid-assertion, with no pod involved. A
// scope fix alone would leave that exactly as broken as it was.
const {
  scope: SCOPE,
  otherScope: OTHER_SCOPE,
  testImageTag,
  cleanup,
} = podmanTestScope("ensure-images");

// Collection time, not beforeAll: vitest evaluates `runIf` while building the
// suite, so a flag set in a hook arrives too late and silently skips
// everything — a test file that always passes by never running. Under
// `SANDBAR_REQUIRE_PODMAN_TESTS=1` (the gate runner's env, #48) an unreachable
// podman is a FAILING test rather than a skip.
const available = podmanTestsEnabled({
  what: "ensure-images podman tests",
  image: BASE,
});

describe.runIf(available)("ensureImages against real podman", () => {
  // `cleanup` is the two production sweepers plus the tags they cannot see —
  // which covers both `ours` and `theirs` below, since OTHER_SCOPE is this
  // process's too. Nothing reaps it if the process is SIGKILLed; the recovery
  // command is in `podman-test-scope.test-util.ts`.
  afterAll(cleanup, 120_000);

  const fixture = async (taskId: string, onTestFinished: FinishedHook) => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-ensure-images-"));
    const tag = testImageTag(`probe-${taskId}`);
    const image: BuiltImage = {
      tag,
      containerfile: "Containerfile",
      rebuildOn: ["package-lock.json"],
    };
    await writeFile(
      join(root, "Containerfile"),
      `FROM ${BASE}\nCOPY package-lock.json /lock.json\n`,
    );
    await writeFile(join(root, "package-lock.json"), '{"v":1}\n');
    onTestFinished(() => rm(root, { recursive: true, force: true }), 60_000);
    return { root, tag, image };
  };

  const imageId = async (tag: string): Promise<string> =>
    (
      await exec(RUNTIME, ["image", "inspect", tag, "--format", "{{.Id}}"])
    ).stdout.trim();

  it.concurrent(
    "classifies an absent image as having no inputs label",
    async ({ expect, task }) => {
      expect(await readInputsLabel(testImageTag(`absent-${task.id}`))).toBeNull();
    },
    120_000,
  );

  it.concurrent(
    "builds a generated tar context and applies COPY --chmod",
    async ({ expect, task, onTestFinished }) => {
      const tag = testImageTag(`generated-${task.id}`);
      const context = await mkdtemp(join(tmpdir(), "sandbar-generated-context-"));
      onTestFinished(() => rm(context, { recursive: true, force: true }), 60_000);
      await writeFile(join(context, "Containerfile"),
        `FROM ${BASE}\nCOPY --chmod=0755 payload /usr/local/bin/payload\n`);
      await writeFile(join(context, "payload"), "generated-context\n");
      await buildImage({ tag, containerfile: "<generated>" }, {
        root: "", contextRoot: context, capture: true,
      });
      const result = await exec(RUNTIME, [
        "run", "--rm", tag, "sh", "-c",
        "test -x /usr/local/bin/payload && cat /usr/local/bin/payload",
      ]);
      expect(result.stdout).toContain("generated-context");
    },
    600_000,
  );

  it.concurrent(
    "reports a missing generated context as an image build failure",
    async ({ expect, task, onTestFinished }) => {
      const { root, tag } = await fixture(task.id, onTestFinished);
      const missing = join(root, "does-not-exist");
      const error = await buildImage(
        { tag, containerfile: "<generated>" },
        { root: "", contextRoot: missing, capture: true },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ImageBuildError);
      expect((error as ImageBuildError).output).toMatch(/tar:|Cannot open|cannot open/i);
    },
    120_000,
  );

  for (const [base, packageManager, selectedVariant] of [
    ["docker.io/library/alpine:3.22", "apk", "musl"],
    ["docker.io/library/debian:bookworm-slim", "apt-get", "glibc"],
  ] as const) {
    it.concurrent(
      `executes the generated git, user, and ${selectedVariant} selection contract over ${packageManager}`,
      async ({ expect, task, onTestFinished }) => {
        const tag = testImageTag(`agent-recipe-${selectedVariant}-${task.id}`);
        const context = await mkdtemp(join(tmpdir(), "sandbar-agent-recipe-"));
        onTestFinished(() => rm(context, { recursive: true, force: true }), 60_000);
        const artifact = AGENT_PROVIDER_PACKAGES.codex.artifacts.x64[0]!;
        const packages = {
          ...AGENT_PROVIDER_PACKAGES,
          codex: {
            ...AGENT_PROVIDER_PACKAGES.codex,
            artifacts: {
              x64: [
                { ...artifact, variant: "glibc" as const },
                { ...artifact, variant: "musl" as const },
              ],
              arm64: AGENT_PROVIDER_PACKAGES.codex.artifacts.arm64,
            },
          },
        };
        await writeFile(
          join(context, "Containerfile"),
          agentToolsContainerfile(base, ["codex"], {
            arch: "x64", packages, libc: selectedVariant,
          }),
        );
        await writeFile(
          join(context, "codex-glibc"),
          "#!/bin/sh\necho 'codex glibc fixture'\n",
        );
        await writeFile(
          join(context, "codex-musl"),
          "#!/bin/sh\necho 'codex musl fixture'\n",
        );
        await buildImage({ tag, containerfile: "<generated>" }, {
          root: "", contextRoot: context, capture: true, timeoutMs: 600_000,
        });
        const result = await exec(RUNTIME, [
          "run", "--rm", tag, "sh", "-c",
          "git --version && codex --version && test $(id -u agent) = 1000 && test $(stat -c %u /home/agent) = 1000",
        ]);
        expect(result.stdout).toContain(`codex ${selectedVariant} fixture`);
      },
      600_000,
    );
  }

  it.concurrent(
    "detects musl and glibc bases and rethrows runtime failures",
    async ({ expect }) => {
      expect(await detectImageLibc("docker.io/library/alpine:3.22")).toBe("musl");
      expect(await detectImageLibc("docker.io/library/debian:bookworm-slim")).toBe("glibc");
      await expect(detectImageLibc("localhost/sandbar-missing-libc-base:test"))
        .rejects.toThrow();
    },
    600_000,
  );

  it.concurrent(
    "renames an existing uid-1000 user and preserves its writable home contract",
    async ({ expect, task, onTestFinished }) => {
      const uidBaseTag = testImageTag(`uid-base-${task.id}`);
      const tag = testImageTag(`uid-recipe-${task.id}`);
      const baseContext = await mkdtemp(join(tmpdir(), "sandbar-agent-uid-base-"));
      onTestFinished(() => rm(baseContext, { recursive: true, force: true }), 60_000);
      await writeFile(
        join(baseContext, "Containerfile"),
        "FROM docker.io/library/alpine:3.22\nRUN adduser -D -u 1000 -h /home/node node\n",
      );
      await buildImage({ tag: uidBaseTag, containerfile: "<generated>" }, {
        root: "", contextRoot: baseContext, capture: true,
      });
      const context = await mkdtemp(join(tmpdir(), "sandbar-agent-uid-recipe-"));
      onTestFinished(() => rm(context, { recursive: true, force: true }), 60_000);
      await writeFile(
        join(context, "Containerfile"),
        agentToolsContainerfile(uidBaseTag, ["codex"], { libc: "musl" }),
      );
      await writeFile(join(context, "codex-static"), "#!/bin/sh\necho fixture\n");
      // The recipe installs every binary the provider declares (#120), so the
      // context has to carry the code-mode host beside the CLI.
      await writeFile(
        join(context, "codex-code-mode-host-static"),
        "#!/bin/sh\necho fixture-host\n",
      );
      await buildImage({ tag, containerfile: "<generated>" }, {
        root: "", contextRoot: context, capture: true, timeoutMs: 600_000,
      });
      const result = await exec(RUNTIME, [
        "run", "--rm", tag, "sh", "-c",
        "test $(id -u agent) = 1000 && ! id node >/dev/null 2>&1 && test $(stat -c %u /home/agent) = 1000 && test -w /home/agent",
      ]);
      expect(result.stderr).toBe("");
    },
    600_000,
  );

  it.concurrent(
    "records the fingerprint as a label, and rebuilds only when the declared inputs change",
    async ({ expect, task, onTestFinished }) => {
      const { root, tag: TAG, image } = await fixture(task.id, onTestFinished);

      const first = await ensureImages([image], root);
      const fingerprint = first.get(TAG);
      expect(fingerprint).toEqual(expect.any(String));
      // The round trip the whole staleness decision rests on.
      expect(await readInputsLabel(TAG)).toBe(fingerprint);

      // Warm: same inputs, so no build at all. Asserted on the image ID rather
      // than on timing — a fully-cached rebuild is fast enough to be invisible.
      const id = await imageId(TAG);
      const second = await ensureImages([image], root);
      expect(second.get(TAG)).toBe(fingerprint);
      expect(await imageId(TAG)).toBe(id);

      // A change to a declared input rebuilds, which is the whole point: the
      // pre-#37 policy was "the tag exists, therefore this image is current".
      await writeFile(join(root, "package-lock.json"), '{"v":2}\n');
      const third = await ensureImages([image], root);
      expect(third.get(TAG)).not.toBe(fingerprint);
      expect(await readInputsLabel(TAG)).toBe(third.get(TAG));
      expect(await imageId(TAG)).not.toBe(id);

      // A change to the RECIPE counts too — an image is a function of its own
      // Containerfile, and that also never entered the tag-only cache key.
      await writeFile(
        join(root, "Containerfile"),
        `FROM ${BASE}\nCOPY package-lock.json /lock.json\nRUN true\n`,
      );
      const fourth = await ensureImages([image], root);
      expect(fourth.get(TAG)).not.toBe(third.get(TAG));
    },
    600_000,
  );

  // #45. `rebuildInPlace: false` is what the standalone `sandbar gate` passes,
  // and it is a safety property rather than a speed one: rewriting a DECLARED
  // tag mutates the one podman resource class no scope partitions, and that
  // command holds no lock, so beside a live run it would rebuild that run's
  // base image from another tree. The two assertions here are the two halves of
  // it working — the tag on disk is untouched, and the baseline handed back is
  // what the IMAGE records rather than what the context hashes to, which is the
  // only input that makes `createBranchImages` route the difference into a
  // scoped variant instead of trusting the base tag.
  it.concurrent(
    "leaves a stale declared tag alone and reports the image's own fingerprint",
    async ({ expect, task, onTestFinished }) => {
      const { root, tag: TAG, image } = await fixture(task.id, onTestFinished);

      const first = await ensureImages([image], root);
      const fingerprint = first.get(TAG);
      const id = await imageId(TAG);

      await writeFile(join(root, "package-lock.json"), '{"v":9}\n');
      const held = await ensureImages([image], root, { rebuildInPlace: false });

      // Not rebuilt, and not re-tagged: this is the process that must not
      // clobber a tag someone else is relying on.
      expect(await imageId(TAG)).toBe(id);
      expect(await readInputsLabel(TAG)).toBe(fingerprint);
      // And the baseline describes the IMAGE, not this tree — hand back the
      // tree's own fingerprint here and the per-branch resolver compares equal,
      // uses the base tag, and gates against an image built from other bytes.
      expect(held.get(TAG)).toBe(fingerprint);

      // The default is unchanged, which is what a run still gets.
      const rebuilt = await ensureImages([image], root);
      expect(rebuilt.get(TAG)).not.toBe(fingerprint);
      expect(await imageId(TAG)).not.toBe(id);
    },
    600_000,
  );

  // A MISSING tag is still built either way: there is nothing to clobber, and
  // refusing would mean `sandbar gate` could not run in CI from a fresh
  // checkout, which is most of the point of it existing.
  it.concurrent(
    "still builds a declared tag that does not exist yet",
    async ({ expect, task, onTestFinished }) => {
      const { root, tag: TAG, image } = await fixture(task.id, onTestFinished);

      const built = await ensureImages([image], root, {
        rebuildInPlace: false,
      });
      expect(await readInputsLabel(TAG)).toBe(built.get(TAG));
      expect(built.get(TAG)).toEqual(expect.any(String));
    },
    600_000,
  );

  it.concurrent(
    "reports a failing CAPTURED build with the build's own output — the diagnosis a gate red has to carry",
    async ({ expect, task, onTestFinished }) => {
      const { root, tag: TAG, image } = await fixture(task.id, onTestFinished);

      // The per-branch path captures rather than inheriting, and this is why:
      // its failure travels into a red gate's trace and on to an implementer,
      // who has nothing to act on from "exited with code 1". The base build
      // inherits instead (a cold multi-minute build should show progress) and
      // its failure halts the run in front of the operator who just watched it.
      await writeFile(
        join(root, "Containerfile"),
        `FROM ${BASE}\nRUN echo LOCKFILE-IS-BROKEN >&2; exit 7\n`,
      );
      const err = await buildImage(image, { root, capture: true }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ImageBuildError);
      expect((err as ImageBuildError).tag).toBe(TAG);
      expect((err as ImageBuildError).output).toContain("LOCKFILE-IS-BROKEN");
      // …and on the message too, so a caller that only logs the error still
      // shows it.
      expect((err as Error).message).toContain("LOCKFILE-IS-BROKEN");
    },
    600_000,
  );

  it.concurrent(
    "halts a failing BASE build rather than leaving a stale tag in place",
    async ({ expect, task, onTestFinished }) => {
      const { root, image } = await fixture(task.id, onTestFinished);

      await writeFile(
        join(root, "Containerfile"),
        `FROM ${BASE}\nRUN exit 7\n`,
      );
      await expect(ensureImages([image], root)).rejects.toBeInstanceOf(
        ImageBuildError,
      );
    },
    600_000,
  );

  it.concurrent(
    "sweeps this scope's leftover per-branch images and leaves another scope's alone",
    async ({ expect, task, onTestFinished }) => {
      const { root, tag: TAG, image } = await fixture(task.id, onTestFinished);

      // The run-end removal is an `onCleanup` action, so it does not run on
      // SIGKILL or a hard crash — and these are the largest things sandbar
      // creates. This sweep is what makes the scope segment in the tag mean
      // something, and it must not reach a concurrent run's live images.
      //
      // OTHER_SCOPE stands in for that other run and is derived from this
      // process's own token (#47), so it is a scope the sweep must be blind to
      // without ever being a scope somebody else is really using.
      const ours = variantImageTag(TAG, SCOPE, "deadbeefcafe");
      const theirs = variantImageTag(TAG, OTHER_SCOPE, "deadbeefcafe");
      await ensureImages([image], root);
      await exec(RUNTIME, ["tag", TAG, ours]);
      await exec(RUNTIME, ["tag", TAG, theirs]);

      const result = await sweepBranchImages(SCOPE);
      expect(result.failures).toEqual([]);
      expect(result.removed).toContain(ours);
      expect(result.removed).not.toContain(theirs);

      const listed = (
        await exec(RUNTIME, ["images", "--format", "{{.Repository}}:{{.Tag}}"])
      ).stdout;
      expect(listed).not.toContain(ours);
      expect(listed).toContain(theirs);
      // The BASE tag is untouched — `podman rmi -f` on a multi-tagged image
      // untags rather than deleting, and the base is what `ensureImages` built.
      expect(listed).toContain(TAG);
    },
    600_000,
  );

  it.concurrent(
    "refuses a declared path that is not in the build context, instead of going inert",
    async ({ expect, task, onTestFinished }) => {
      const { root, image } = await fixture(task.id, onTestFinished);

      // A typo here would otherwise make the whole declaration a no-op: the
      // path is absent from every tree, so it compares equal everywhere and the
      // gate goes back to being pinned to the source branch.
      await expect(
        ensureImages(
          [{ ...image, rebuildOn: ["package-lock.json", "bwoer.json"] }],
          root,
        ),
      ).rejects.toThrow(/bwoer\.json/);
    },
    120_000,
  );
});
