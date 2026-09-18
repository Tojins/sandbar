import { describe, expect, it } from "vitest";

import {
  IMAGE_SCOPE_LABEL,
  imagesToRemove,
  parseContainerImageIds,
  parseImageInventory,
  reconcileImages,
} from "./image-lifecycle.js";
import { runScope } from "./naming.js";

const scope = runScope("/image-lifecycle");
const row = (overrides: Record<string, unknown>): string => JSON.stringify({
  Id: "id-default",
  ParentId: "",
  RepoTags: null,
  Labels: null,
  ...overrides,
});

describe("image lifecycle", () => {
  it("selects owned predecessors, stopped tags and stages but preserves every live source", () => {
    const inventory = parseImageInventory([
      row({ Id: "declared", RepoTags: ["localhost/app:gate"], Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "latest", RepoTags: ["localhost/helper:latest"], Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "registry", RepoTags: ["registry.example/app:gate"], Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "predecessor", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "old-tag", RepoTags: ["app:removed"], Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "container-image", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "foreign", Labels: { [IMAGE_SCOPE_LABEL]: runScope("/sibling") } }),
      row({ Id: "unlabelled" }),
    ].join("\n"));

    expect(imagesToRemove(
      inventory,
      scope,
      new Set(["app:gate", "helper", "registry.example/app:gate"]),
      new Set(["container-image"]),
    )).toEqual(["predecessor", "old-tag"]);
  });

  it("orders descendants before parents and tolerates parent cycles", () => {
    const inventory = parseImageInventory([
      row({ Id: "parent", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "child", ParentId: "parent", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "grandchild", ParentId: "child", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "cycle-a", ParentId: "cycle-b", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
      row({ Id: "cycle-b", ParentId: "cycle-a", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
    ].join("\n"));
    const selected = imagesToRemove(inventory, scope, new Set(), new Set());
    expect(selected.indexOf("grandchild")).toBeLessThan(selected.indexOf("child"));
    expect(selected.indexOf("child")).toBeLessThan(selected.indexOf("parent"));
    expect(selected).toEqual(expect.arrayContaining(["cycle-a", "cycle-b"]));
  });

  it("parses all non-empty container image IDs", () => {
    expect([...parseContainerImageIds("one\n\ntwo\n")]).toEqual(["one", "two"]);
  });

  it("uses full inventories and removes by ID without pruning unrelated parents", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const result = await reconcileImages({
      scope,
      liveTags: new Set(["app:live"]),
      run: async (args) => {
        mutableCalls.push([...args]);
        if (args[0] === "images") {
          return { stdout: [
            row({ Id: "live", RepoTags: ["app:live"], Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
            row({ Id: "stale", Labels: { [IMAGE_SCOPE_LABEL]: scope } }),
          ].join("\n") };
        }
        if (args[0] === "ps") return { stdout: "\n" };
        return { stdout: "" };
      },
    });
    expect(result).toEqual({ removed: ["stale"], failures: [] });
    expect(calls).toEqual([
      ["images", "-a", "--no-trunc", "--format", "{{json .}}"],
      ["ps", "-a", "--external", "--no-trunc", "--format", "{{.ImageID}}"],
      ["rmi", "-f", "--no-prune", "stale"],
    ]);
  });

  it("rejects an unreadable inventory instead of declaring it empty", () => {
    expect(() => parseImageInventory("not-json\n")).toThrow(/invalid image inventory/);
  });

  it.each([
    ["RepoTags", { RepoTags: "app:gate" }],
    ["RepoTags", { RepoTags: ["app:gate", 42] }],
    ["Labels", { Labels: [] }],
    ["Labels", { Labels: { [IMAGE_SCOPE_LABEL]: 42 } }],
    ["ParentId", { ParentId: 42 }],
  ])("rejects malformed %s instead of weakening the deletion boundary", (_field, malformed) => {
    expect(() => parseImageInventory(row(malformed))).toThrow(/malformed/);
  });

  it("propagates image removal failures", async () => {
    const failure = new Error("storage lock failed");
    await expect(reconcileImages({
      scope,
      liveTags: new Set(),
      run: async (args) => {
        if (args[0] === "images") {
          return { stdout: row({
            Id: "stale",
            Labels: { [IMAGE_SCOPE_LABEL]: scope },
          }) };
        }
        if (args[0] === "ps") return { stdout: "" };
        throw failure;
      },
    })).rejects.toBe(failure);
  });
});
