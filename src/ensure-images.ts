// Lazy-build the sandbar image in podman. The sandbox provider, the
// gate runner, and the pg sidecar all use podman, so one image build
// covers everything.
//
// We shell out to `podman build` directly rather than `sandcastle podman
// build-image` to keep the build context scoped to the workDir (the
// sandcastle CLI sets context = cwd when given a custom Dockerfile path,
// which would tar the whole repo). The call is skipped when the image
// already exists, so warm runs pay only one `image exists` call.

import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { RUNTIME } from "./pg-sidecar.js";

const exec = promisify(execFile);

export type EnsureImagesOptions = {
  readonly gateImage: string;
  readonly containerfilePath: string;
};

async function imageExists(gateImage: string): Promise<boolean> {
  try {
    await exec(RUNTIME, ["image", "exists", gateImage]);
    return true;
  } catch {
    return false;
  }
}

async function buildImage(opts: EnsureImagesOptions): Promise<void> {
  console.log(
    `Building ${opts.gateImage} in ${RUNTIME} (one-time setup; cached afterwards)...`,
  );
  const context = dirname(opts.containerfilePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      RUNTIME,
      ["build", "-t", opts.gateImage, "-f", opts.containerfilePath, context],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`\`${RUNTIME} build\` exited with code ${code}`)),
    );
  });
}

export async function ensureImages(opts: EnsureImagesOptions): Promise<void> {
  if (!(await imageExists(opts.gateImage))) {
    await buildImage(opts);
  }
}
