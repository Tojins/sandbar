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
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, it } from "vitest";

import type { BuiltImage } from "./config.js";
import { AGENT_PROVIDER_PACKAGES } from "./agent-providers.js";
import {
  agentToolsContainerfile,
  agentToolsImageContainerfile,
  detectImageLibc,
} from "./agent-tools.js";
import {
  ImageBuildError,
  buildImage,
  ensureImages,
  readInputsLabel,
} from "./ensure-images.js";
import {
  IMAGE_SCOPE_LABEL,
  parseImageInventory,
  reconcileImages,
} from "./image-lifecycle.js";
import { stackContainerNameFor, variantImageTag } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  type FinishedHook,
  podmanTestScope,
  podmanTestStackId,
  removeFixtureContainerOnTestFinished,
  runFixtureContainer,
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

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

async function serveArtifacts(
  root: string,
  taskId: string,
  paths: Readonly<Record<string, string>>,
  onTestFinished: FinishedHook,
): Promise<string> {
  // The gate runner may be a container driving a remote podman socket. Keep
  // the fixture beside Buildah and publish it on that host's loopback, where
  // ADD's host-side downloader can reach it in either local or remote mode.
  const context = await mkdtemp(join(root, "server-context-"));
  const artifacts = join(context, "artifacts");
  await mkdir(artifacts);
  for (const [path, file] of Object.entries(paths)) {
    if (!/^\/[a-zA-Z0-9._-]+$/.test(path)) {
      throw new Error(
        `artifact fixture path must be a root-level filename: ${path}`,
      );
    }
    await writeFile(join(artifacts, path.slice(1)), await readFile(file));
  }
  await writeFile(
    join(context, "Containerfile"),
    // Alpine's busybox build omits the `httpd` applet ("applet not found",
    // exit 127 before listen); the upstream busybox image ships it.
    "FROM docker.io/library/busybox:1.37\n" +
      "COPY artifacts/ /srv/\n" +
      "CMD [\"busybox\", \"httpd\", \"-f\", \"-p\", \"8080\", \"-h\", \"/srv\"]\n",
  );
  const tag = testImageTag(`artifact-server-${taskId}`);
  await buildImage({ tag, containerfile: "<generated-artifact-server>" }, {
    scope: SCOPE, root: "", contextRoot: context, capture: true,
  });
  const container = stackContainerNameFor(
    SCOPE,
    podmanTestStackId("artifact-server", taskId),
    "http",
  );
  await runFixtureContainer([
    "--name", container, "-p", "127.0.0.1::8080", tag,
  ]);
  removeFixtureContainerOnTestFinished(onTestFinished, container);
  const probePath = Object.keys(paths)[0];
  if (probePath === undefined) {
    throw new Error("artifact server requires at least one fixture path");
  }
  // `podman run -d` returns once the container process exists, before httpd
  // necessarily reaches listen(2). Wait inside the server container so the
  // subsequent host-side Buildah ADD cannot race its startup.
  await exec(RUNTIME, [
    "exec",
    container,
    "sh",
    "-c",
    `for delay in $(seq 1 100); do wget -q -O /dev/null http://127.0.0.1:8080${probePath} && exit 0; sleep 0.1; done; exit 1`,
  ]);
  const published = (
    await exec(RUNTIME, [
      "container",
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
      container,
    ])
  ).stdout.trim();
  if (!/^\d+$/.test(published)) {
    throw new Error(
      `podman did not publish the artifact server port for ${container}`,
    );
  }
  return `http://127.0.0.1:${published}`;
}

describe.runIf(available)("ensureImages against real podman", () => {
  // `cleanup` is the two production sweepers plus the tags they cannot see —
  // which covers every scope this file creates. Nothing reaps it if the
  // process is SIGKILLed; the recovery
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
        scope: SCOPE, root: "", contextRoot: context, capture: true,
      });
      const result = await exec(RUNTIME, [
        "run", "--rm", tag, "sh", "-c",
        "test -x /usr/local/bin/payload && cat /usr/local/bin/payload",
      ]);
      expect(result.stdout).toContain("generated-context");
    },
    600_000,
  );

  it(
    "executes generated direct and archive downloads with checksum and member validation",
    async ({ expect, task, onTestFinished }) => {
      const root = await mkdtemp(join(tmpdir(), "sandbar-tools-downloads-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }), 60_000);

      const direct = join(root, "claude");
      await writeFile(direct, "direct fixture\n", { mode: 0o600 });
      const exactRoot = join(root, "exact");
      const prefixedRoot = join(root, "prefixed");
      const ambiguousRoot = join(root, "ambiguous");
      await Promise.all([
        mkdir(exactRoot),
        mkdir(prefixedRoot),
        mkdir(ambiguousRoot),
      ]);
      await Promise.all([
        writeFile(join(exactRoot, "codex"), "exact archive fixture\n", {
          mode: 0o600,
        }),
        writeFile(
          join(prefixedRoot, "codex-code-mode-host-x86_64-unknown-linux-musl"),
          "prefixed archive fixture\n",
          { mode: 0o600 },
        ),
        writeFile(join(ambiguousRoot, "codex-one"), "one\n"),
        writeFile(join(ambiguousRoot, "codex-two"), "two\n"),
      ]);
      const exact = join(root, "codex.tar.gz");
      const prefixed = join(root, "codex-host.tar.gz");
      const ambiguous = join(root, "ambiguous.tar.gz");
      await Promise.all([
        exec("tar", ["-czf", exact, "-C", exactRoot, "."]),
        exec("tar", ["-czf", prefixed, "-C", prefixedRoot, "."]),
        exec("tar", ["-czf", ambiguous, "-C", ambiguousRoot, "."]),
      ]);

      const artifactOrigin = await serveArtifacts(
        root,
        task.id,
        {
          "/claude": direct,
          "/codex.tar.gz": exact,
          "/codex-host.tar.gz": prefixed,
          "/ambiguous.tar.gz": ambiguous,
        },
        onTestFinished,
      );
      const directArtifact = {
        variant: "static" as const,
        url: `${artifactOrigin}/claude`,
        sha256: await sha256(direct),
      };
      const exactArtifact = {
        variant: "static" as const,
        url: `${artifactOrigin}/codex.tar.gz`,
        sha256: await sha256(exact),
        archive: true,
      };
      const prefixedArtifact = {
        variant: "static" as const,
        binary: "codex-code-mode-host",
        url: `${artifactOrigin}/codex-host.tar.gz`,
        sha256: await sha256(prefixed),
        archive: true,
      } as const;
      const packages: typeof AGENT_PROVIDER_PACKAGES = {
        claude: {
          version: "fixture",
          artifacts: { x64: [directArtifact], arm64: [directArtifact] },
        },
        codex: {
          version: "fixture",
          artifacts: {
            x64: [exactArtifact, prefixedArtifact],
            arm64: [exactArtifact, prefixedArtifact],
          },
        },
      };
      const tag = testImageTag(`tools-download-${task.id}`);
      const context = await mkdtemp(join(root, "context-"));
      await writeFile(
        join(context, "Containerfile"),
        agentToolsImageContainerfile(
          "docker.io/library/alpine:3.22",
          ["claude", "codex"],
          { arch: "x64", libc: "musl", packages },
        ),
      );
      await buildImage({ tag, containerfile: "<generated-agent-tools-download>" }, {
        scope: SCOPE,
        root: "",
        contextRoot: context,
        capture: true,
        timeoutMs: 600_000,
      });

      const container = stackContainerNameFor(
        SCOPE,
        podmanTestStackId("artifact-inspect", task.id),
        "tools",
      );
      await exec(RUNTIME, [
        "create",
        "--name",
        container,
        "--image-volume=ignore",
        tag,
        "/usr/local/bin/claude",
      ]);
      removeFixtureContainerOnTestFinished(onTestFinished, container);
      const copied = await mkdtemp(join(root, "copied-"));
      await exec(RUNTIME, ["cp", `${container}:/usr/local/bin/.`, copied]);
      for (const [binary, content] of [
        ["claude", "direct fixture\n"],
        ["codex", "exact archive fixture\n"],
        ["codex-code-mode-host", "prefixed archive fixture\n"],
      ] as const) {
        const path = join(copied, binary);
        expect(await readFile(path, "utf8")).toBe(content);
        expect((await stat(path)).mode & 0o111).toBe(0o111);
      }

      const ambiguousPackages: typeof AGENT_PROVIDER_PACKAGES = {
        ...packages,
        codex: {
          version: "fixture",
          artifacts: {
            x64: [{
              ...exactArtifact,
              url: `${artifactOrigin}/ambiguous.tar.gz`,
              sha256: await sha256(ambiguous),
            }],
            arm64: [exactArtifact],
          },
        },
      };
      const ambiguousTag = testImageTag(`tools-ambiguous-${task.id}`);
      await writeFile(
        join(context, "Containerfile"),
        agentToolsImageContainerfile(
          "docker.io/library/alpine:3.22",
          ["codex"],
          { arch: "x64", libc: "musl", packages: ambiguousPackages },
        ),
      );
      await expect(buildImage(
        { tag: ambiguousTag, containerfile: "<generated-agent-tools-download>" },
        { scope: SCOPE, root: "", contextRoot: context, capture: true, timeoutMs: 600_000 },
      )).rejects.toMatchObject({
        output: expect.stringContaining("archive contains no unique codex binary"),
      });

      const checksumPackages: typeof AGENT_PROVIDER_PACKAGES = {
        ...packages,
        claude: {
          version: "fixture",
          artifacts: {
            x64: [{ ...directArtifact, sha256: "0".repeat(64) }],
            arm64: [directArtifact],
          },
        },
      };
      const checksumTag = testImageTag(`tools-checksum-${task.id}`);
      await writeFile(
        join(context, "Containerfile"),
        agentToolsImageContainerfile(
          "docker.io/library/alpine:3.22",
          ["claude"],
          { arch: "x64", libc: "musl", packages: checksumPackages },
        ),
      );
      const checksumError = await buildImage(
        { tag: checksumTag, containerfile: "<generated-agent-tools-download>" },
        { scope: SCOPE, root: "", contextRoot: context, capture: true, timeoutMs: 600_000 },
      ).catch((error: unknown) => error);
      expect(checksumError).toBeInstanceOf(ImageBuildError);
      expect((checksumError as ImageBuildError).output).toMatch(
        /checksum|digest|sha256/i,
      );
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
        { scope: SCOPE, root: "", contextRoot: missing, capture: true },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ImageBuildError);
      expect((error as ImageBuildError).output).toMatch(
        /context must be a directory|Cannot open|cannot open/i,
      );
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
        const toolsTag = testImageTag(`agent-tools-${selectedVariant}-${task.id}`);
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
          join(context, "codex-glibc"),
          "#!/bin/sh\necho 'codex glibc fixture'\n",
        );
        await writeFile(
          join(context, "codex-musl"),
          "#!/bin/sh\necho 'codex musl fixture'\n",
        );
        await writeFile(
          join(context, "Containerfile"),
          `FROM scratch\nCOPY --chmod=0755 codex-${selectedVariant} /usr/local/bin/codex\n`,
        );
        await buildImage({ tag: toolsTag, containerfile: "<generated>" }, {
          scope: SCOPE, root: "", contextRoot: context, capture: true, timeoutMs: 600_000,
        });
        await writeFile(
          join(context, "Containerfile"),
          agentToolsContainerfile(base, toolsTag, ["codex"], {
            arch: "x64", packages, libc: selectedVariant,
          }),
        );
        await buildImage({ tag, containerfile: "<generated>" }, {
          scope: SCOPE, root: "", contextRoot: context, capture: true, timeoutMs: 600_000,
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
    "preserves uid-1000 home ownership and a writable shared Codex credential mount",
    async ({ expect, task, onTestFinished }) => {
      const uidBaseTag = testImageTag(`uid-base-${task.id}`);
      const tag = testImageTag(`uid-recipe-${task.id}`);
      const toolsTag = testImageTag(`uid-tools-${task.id}`);
      const codexHome = "/var/lib/sandbar-codex";
      const baseContext = await mkdtemp(join(tmpdir(), "sandbar-agent-uid-base-"));
      onTestFinished(() => rm(baseContext, { recursive: true, force: true }), 60_000);
      await writeFile(
        join(baseContext, "Containerfile"),
        "FROM docker.io/library/alpine:3.22\nRUN adduser -D -u 1000 -h /home/node node\n",
      );
      await buildImage({ tag: uidBaseTag, containerfile: "<generated>" }, {
        scope: SCOPE, root: "", contextRoot: baseContext, capture: true,
      });
      await exec(RUNTIME, ["run", "--rm", uidBaseTag, "test", "!", "-e", codexHome]);
      const context = await mkdtemp(join(tmpdir(), "sandbar-agent-uid-recipe-"));
      onTestFinished(() => rm(context, { recursive: true, force: true }), 60_000);
      const hostAuth = join(context, "codex-auth.json");
      await writeFile(hostAuth, "before", { mode: 0o600 });
      await writeFile(join(context, "codex-static"), "#!/bin/sh\necho fixture\n");
      // The recipe installs every binary the provider declares (#120), so the
      // context has to carry the code-mode host beside the CLI.
      await writeFile(
        join(context, "codex-code-mode-host-static"),
        "#!/bin/sh\necho fixture-host\n",
      );
      await writeFile(
        join(context, "Containerfile"),
        "FROM scratch\n" +
          "COPY --chmod=0755 codex-static /usr/local/bin/codex\n" +
          "COPY --chmod=0755 codex-code-mode-host-static /usr/local/bin/codex-code-mode-host\n",
      );
      await buildImage({ tag: toolsTag, containerfile: "<generated>" }, {
        scope: SCOPE, root: "", contextRoot: context, capture: true, timeoutMs: 600_000,
      });
      await writeFile(
        join(context, "Containerfile"),
        agentToolsContainerfile(uidBaseTag, toolsTag, ["codex"], {
          libc: "musl", codexHome,
        }),
      );
      await buildImage({ tag, containerfile: "<generated>" }, {
        scope: SCOPE, root: "", contextRoot: context, capture: true, timeoutMs: 600_000,
      });
      const result = await exec(RUNTIME, [
        "run", "--rm",
        "--userns=keep-id:uid=1000,gid=1000",
        "--user", "1000:1000",
        "-v", `${hostAuth}:${codexHome}/auth.json:z`,
        tag, "sh", "-c",
        `test $(id -u) = 1000 && ! id node >/dev/null 2>&1 && ` +
          `test $(stat -c %u /home/agent) = 1000 && test -w /home/agent && ` +
          `printf refreshed > ${codexHome}/auth.json && ` +
          `printf session > ${codexHome}/history.jsonl`,
      ]);
      expect(result.stderr).toBe("");
      expect(await readFile(hostAuth, "utf8")).toBe("refreshed");
    },
    600_000,
  );

  it.concurrent(
    "records the fingerprint as a label, and rebuilds only when the declared inputs change",
    async ({ expect, task, onTestFinished }) => {
      const { root, tag: TAG, image } = await fixture(task.id, onTestFinished);

      const first = await ensureImages([image], root, { scope: SCOPE });
      const fingerprint = first.get(TAG);
      expect(fingerprint).toEqual(expect.any(String));
      // The round trip the whole staleness decision rests on.
      expect(await readInputsLabel(TAG)).toBe(fingerprint);

      // Warm: same inputs, so no build at all. Asserted on the image ID rather
      // than on timing — a fully-cached rebuild is fast enough to be invisible.
      const id = await imageId(TAG);
      const second = await ensureImages([image], root, { scope: SCOPE });
      expect(second.get(TAG)).toBe(fingerprint);
      expect(await imageId(TAG)).toBe(id);

      // A change to a declared input rebuilds, which is the whole point: the
      // pre-#37 policy was "the tag exists, therefore this image is current".
      await writeFile(join(root, "package-lock.json"), '{"v":2}\n');
      const third = await ensureImages([image], root, { scope: SCOPE });
      expect(third.get(TAG)).not.toBe(fingerprint);
      expect(await readInputsLabel(TAG)).toBe(third.get(TAG));
      expect(await imageId(TAG)).not.toBe(id);

      // A change to the RECIPE counts too — an image is a function of its own
      // Containerfile, and that also never entered the tag-only cache key.
      await writeFile(
        join(root, "Containerfile"),
        `FROM ${BASE}\nCOPY package-lock.json /lock.json\nRUN true\n`,
      );
      const fourth = await ensureImages([image], root, { scope: SCOPE });
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

      const first = await ensureImages([image], root, { scope: SCOPE });
      const fingerprint = first.get(TAG);
      const id = await imageId(TAG);

      await writeFile(join(root, "package-lock.json"), '{"v":9}\n');
      const held = await ensureImages([image], root, {
        scope: SCOPE,
        rebuildInPlace: false,
      });

      // Not rebuilt, and not re-tagged: this is the process that must not
      // clobber a tag someone else is relying on.
      expect(await imageId(TAG)).toBe(id);
      expect(await readInputsLabel(TAG)).toBe(fingerprint);
      // And the baseline describes the IMAGE, not this tree — hand back the
      // tree's own fingerprint here and the per-branch resolver compares equal,
      // uses the base tag, and gates against an image built from other bytes.
      expect(held.get(TAG)).toBe(fingerprint);

      // The default is unchanged, which is what a run still gets.
      const rebuilt = await ensureImages([image], root, { scope: SCOPE });
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
        scope: SCOPE,
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
      const err = await buildImage(image, { scope: SCOPE, root, capture: true }).then(
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
      await expect(ensureImages([image], root, { scope: SCOPE })).rejects.toBeInstanceOf(
        ImageBuildError,
      );
    },
    600_000,
  );

  // Reconciliation removes intermediate image records. Buildah may hand one
  // of those records to a concurrent build as a cache hit before the removal,
  // then fail that build with "layer not known" when it follows the hit. Keep
  // this destructive case behind this file's concurrent build cases.
  it(
    "reconciles untagged predecessors and stopped tags without touching another scope",
    async ({ expect, task, onTestFinished }) => {
      const isolated = podmanTestScope(`ensure-images-reconcile-${task.id}`);
      onTestFinished(isolated.cleanup, 120_000);
      const root = await mkdtemp(join(tmpdir(), "sandbar-ensure-images-reconcile-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }), 60_000);
      const TAG = isolated.testImageTag("probe");
      const image: BuiltImage = {
        tag: TAG,
        containerfile: "Containerfile",
        rebuildOn: ["package-lock.json"],
      };
      await writeFile(
        join(root, "Containerfile"),
        `FROM ${BASE} AS intermediate\n` +
          "COPY package-lock.json /lock.json\n" +
          "RUN cp /lock.json /payload\n" +
          `FROM ${BASE}\n` +
          "COPY --from=intermediate /payload /payload\n",
      );
      await writeFile(join(root, "package-lock.json"), '{"v":1}\n');
      const ownScope = isolated.scope;

      // Reconciliation must reach same-tag predecessors and tags the current
      // config stopped naming while remaining blind to another scope's live
      // images.
      //
      // `isolated.otherScope` stands in for that other run and is derived from this
      // process's own token (#47), so it is a scope the sweep must be blind to
      // without ever being a scope somebody else is really using.
      const stopped = variantImageTag(TAG, ownScope, "deadbeefcafe");
      const sibling = variantImageTag(TAG, isolated.otherScope, "deadbeefcafe");
      await ensureImages([image], root, { scope: ownScope });
      const predecessorId = await imageId(TAG);
      await buildImage({ ...image, tag: stopped }, {
        scope: ownScope, root, capture: true,
      });
      await buildImage({ ...image, tag: sibling }, {
        scope: isolated.otherScope, root, capture: true,
      });
      await writeFile(join(root, "package-lock.json"), '{"v":99}\n');
      await ensureImages([image], root, { scope: ownScope });
      const currentId = await imageId(TAG);
      expect(currentId).not.toBe(predecessorId);

      const inventory = parseImageInventory((
        await exec(RUNTIME, [
          "images", "-a", "--no-trunc", "--format", "{{json .}}",
        ])
      ).stdout);
      const predecessor = inventory.find(({ id }) => id === predecessorId);
      expect(predecessor?.repoTags).toEqual([]);
      const ownedIntermediate = inventory.find((entry) =>
        entry.id !== currentId &&
        entry.id !== predecessorId &&
        entry.labels[IMAGE_SCOPE_LABEL] === ownScope &&
        entry.repoTags.length === 0
      );
      expect(ownedIntermediate).toBeDefined();

      const result = await reconcileImages({
        scope: ownScope,
        liveTags: new Set([TAG]),
      });
      expect(result.removed).toContain(predecessorId);
      await expect(exec(RUNTIME, ["image", "exists", predecessorId])).rejects.toMatchObject({
        code: 1,
      });
      expect(await imageId(TAG)).toBe(currentId);

      const listed = (
        await exec(RUNTIME, ["images", "--format", "{{.Repository}}:{{.Tag}}"])
      ).stdout;
      expect(listed).not.toContain(stopped);
      expect(listed).toContain(sibling);
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
          { scope: SCOPE },
        ),
      ).rejects.toThrow(/bwoer\.json/);
    },
    120_000,
  );
});
