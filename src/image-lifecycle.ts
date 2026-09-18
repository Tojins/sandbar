// Ownership and reconciliation for every image sandbar builds (#169).
//
// Tags are references, not identities. Rebuilding the same tag leaves its
// predecessor untagged, a crashed build can leave intermediate images, and a
// config can stop naming a tag altogether. A tag-glob sweep cannot see any of
// those. Every build therefore writes this workdir's scope to both the final
// image and Buildah's intermediate images; reconciliation lists image IDs and
// removes every owned ID outside the live set.
//
// The live set has two independent sources. Tags retain the declared images
// and the variants/tools pins the driver can still use. Image IDs retain
// anything referenced by an existing container, including stopped
// issue-lifecycle containers. `--external` includes Buildah storage containers
// as well as ordinary Podman containers.
//
// Reconciliation is sequenced only at startup and quiescent scheduler
// boundaries. Its inventory therefore never races sandbar's own builds or
// containers and needs no second lock beside the workdir lock. Individual
// removal failures are reported; a failed inventory propagates, because
// continuing would claim there is no debris on no evidence.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RuntimeExec, SweepResult } from "./containers.js";
import type { RunScope } from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

export const IMAGE_SCOPE_LABEL = "dev.sandbar.scope";
export const IMAGE_LIFECYCLE_TIMEOUT_MS = 30_000;

export function imageScopeLabel(scope: RunScope): string {
  return `${IMAGE_SCOPE_LABEL}=${scope}`;
}

export type ImageInventoryEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly repoTags: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
};

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function parseImageInventory(stdout: string): readonly ImageInventoryEntry[] {
  return stdout.split("\n").filter((line) => line.trim()).map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new Error(`podman returned invalid image inventory JSON: ${line}`, {
        cause,
      });
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`podman returned a non-object image inventory row: ${line}`);
    }
    const row = value as Record<string, unknown>;
    const id = row.Id;
    if (typeof id !== "string" || !id) {
      throw new Error(`podman returned an image inventory row without an ID: ${line}`);
    }
    const rawLabels = row.Labels;
    const labels = typeof rawLabels === "object" && rawLabels !== null
      ? Object.fromEntries(
          Object.entries(rawLabels).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
    return {
      id,
      parentId: typeof row.ParentId === "string" && row.ParentId
        ? row.ParentId
        : null,
      repoTags: stringArray(row.RepoTags),
      labels,
    };
  });
}

export function parseContainerImageIds(stdout: string): ReadonlySet<string> {
  return new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

// Buildah records locally-built short names in canonical `localhost/…:tag`
// form. Config deliberately accepts the same short references Podman accepts,
// so compare canonical forms or a live `app:gate` would fail to retain the
// inventory row Podman reports as `localhost/app:gate`.
function canonicalLocalTag(tag: string): string {
  const slash = tag.indexOf("/");
  const first = slash === -1 ? tag : tag.slice(0, slash);
  const qualified = slash !== -1 &&
    (first === "localhost" || first.includes(".") || first.includes(":"));
  const withRegistry = qualified ? tag : `localhost/${tag}`;
  const lastSlash = withRegistry.lastIndexOf("/");
  return withRegistry.slice(lastSlash + 1).includes(":")
    ? withRegistry
    : `${withRegistry}:latest`;
}

function depthOf(
  image: ImageInventoryEntry,
  byId: ReadonlyMap<string, ImageInventoryEntry>,
): number {
  let depth = 0;
  let parent = image.parentId;
  const seen = new Set<string>([image.id]);
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = byId.get(parent)?.parentId ?? null;
  }
  return depth;
}

export function imagesToRemove(
  inventory: readonly ImageInventoryEntry[],
  scope: RunScope,
  liveTags: ReadonlySet<string>,
  containerImageIds: ReadonlySet<string>,
): readonly string[] {
  const liveIds = new Set(containerImageIds);
  const canonicalLiveTags = new Set([...liveTags].map(canonicalLocalTag));
  for (const image of inventory) {
    if (image.repoTags.some((tag) => canonicalLiveTags.has(canonicalLocalTag(tag)))) {
      liveIds.add(image.id);
    }
  }
  const byId = new Map(inventory.map((image) => [image.id, image] as const));
  return inventory
    .filter((image) =>
      image.labels[IMAGE_SCOPE_LABEL] === scope && !liveIds.has(image.id)
    )
    .sort((a, b) => depthOf(b, byId) - depthOf(a, byId))
    .map((image) => image.id);
}

const defaultExec: RuntimeExec = (args) => exec(RUNTIME, [...args], {
  timeout: IMAGE_LIFECYCLE_TIMEOUT_MS,
});

export async function reconcileImages(args: {
  readonly scope: RunScope;
  readonly liveTags: ReadonlySet<string>;
  readonly run?: RuntimeExec;
}): Promise<SweepResult> {
  const run = args.run ?? defaultExec;
  const inventory = parseImageInventory((await run([
    "images", "-a", "--no-trunc", "--format", "{{json .}}",
  ])).stdout);
  const containerImageIds = parseContainerImageIds((await run([
    "ps", "-a", "--external", "--no-trunc", "--format", "{{.ImageID}}",
  ])).stdout);
  const candidates = imagesToRemove(
    inventory,
    args.scope,
    args.liveTags,
    containerImageIds,
  );
  const removed: string[] = [];
  const failures: string[] = [];
  for (const id of candidates) {
    const argv = ["rmi", "-f", "--no-prune", id];
    const failure = await run(argv).then(
      () => null,
      (err: unknown) => err,
    );
    if (failure === null) {
      removed.push(id);
    } else {
      failures.push(
        `  ${RUNTIME} ${argv.join(" ")}\n    ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }
  return { removed, failures };
}
