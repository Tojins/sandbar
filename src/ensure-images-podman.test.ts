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

import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BuiltImage } from "./config.js";
import {
  ImageBuildError,
  buildImage,
  ensureImages,
  readInputsLabel,
} from "./ensure-images.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const BASE = "docker.io/library/mariadb:10.11";
const TAG = "localhost/sandbar-ensure-images-test:probe";

// Collection time, not beforeAll: vitest evaluates `runIf` while building the
// suite, so a flag set in a hook arrives too late and silently skips
// everything — a test file that always passes by never running.
const available = ((): boolean => {
  if (process.env["SANDBAR_SKIP_PODMAN_TESTS"] === "1") return false;
  try {
    execFileSync(RUNTIME, ["image", "exists", BASE], { stdio: "ignore" });
    return true;
  } catch {
    console.warn(
      `skipping ensure-images podman tests: ${RUNTIME} or ${BASE} unavailable ` +
        `(\`${RUNTIME} pull ${BASE}\` to enable them)`,
    );
    return false;
  }
})();

describe.runIf(available)("ensureImages against real podman", () => {
  let root: string;

  const image: BuiltImage = {
    tag: TAG,
    containerfile: "Containerfile",
    rebuildOn: ["package-lock.json"],
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-ensure-images-"));
    await writeFile(
      join(root, "Containerfile"),
      `FROM ${BASE}\nCOPY package-lock.json /lock.json\n`,
    );
    await writeFile(join(root, "package-lock.json"), '{"v":1}\n');
    await exec(RUNTIME, ["rmi", "-f", TAG]).catch(() => {});
  }, 120_000);

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  afterAll(async () => {
    await exec(RUNTIME, ["rmi", "-f", TAG]).catch(() => {});
  }, 120_000);

  const idOf = async (): Promise<string> =>
    (
      await exec(RUNTIME, ["image", "inspect", TAG, "--format", "{{.Id}}"])
    ).stdout.trim();

  it(
    "records the fingerprint as a label, and rebuilds only when the declared inputs change",
    async () => {
      const first = await ensureImages([image], root);
      const fingerprint = first.get(TAG);
      expect(fingerprint).toEqual(expect.any(String));
      // The round trip the whole staleness decision rests on.
      expect(await readInputsLabel(TAG)).toBe(fingerprint);

      // Warm: same inputs, so no build at all. Asserted on the image ID rather
      // than on timing — a fully-cached rebuild is fast enough to be invisible.
      const id = await idOf();
      const second = await ensureImages([image], root);
      expect(second.get(TAG)).toBe(fingerprint);
      expect(await idOf()).toBe(id);

      // A change to a declared input rebuilds, which is the whole point: the
      // pre-#37 policy was "the tag exists, therefore this image is current".
      await writeFile(join(root, "package-lock.json"), '{"v":2}\n');
      const third = await ensureImages([image], root);
      expect(third.get(TAG)).not.toBe(fingerprint);
      expect(await readInputsLabel(TAG)).toBe(third.get(TAG));
      expect(await idOf()).not.toBe(id);

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

  it(
    "reports a failing CAPTURED build with the build's own output — the diagnosis a gate red has to carry",
    async () => {
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

  it(
    "halts a failing BASE build rather than leaving a stale tag in place",
    async () => {
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

  it(
    "refuses a declared path that is not in the build context, instead of going inert",
    async () => {
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
