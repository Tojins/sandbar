import { describe, expect, it, vi } from "vitest";

import {
  CONTAINER_RESOURCE_TIMEOUT_MS,
  formatContainerResources,
  memoryPeakPath,
  mergeContainerResources,
  parseContainerState,
  parseStatsMemory,
  readContainerResources,
  type ContainerResourceResult,
} from "./container-resources.js";

const result = (stdout: string, exitCode: number | null = 0): ContainerResourceResult => ({
  stdout,
  exitCode,
  timedOut: false,
  maxBufferExceeded: false,
});

describe("container resource evidence", () => {
  it("parses only typed inspect fields", () => {
    expect(parseContainerState("/user.slice/c.scope\ntrue\n")).toEqual({
      cgroupPath: "/user.slice/c.scope",
      oomKilled: true,
    });
    expect(parseContainerState("/user.slice/c.scope\nfalse\n")).toEqual({
      cgroupPath: "/user.slice/c.scope",
      oomKilled: false,
    });
    expect(parseContainerState("<no value>\n<no value>\n")).toEqual({});
  });

  it("keeps the cgroup read beneath the host cgroup root", () => {
    expect(memoryPeakPath("/user.slice/c.scope")).toBe(
      "/sys/fs/cgroup/user.slice/c.scope/memory.peak",
    );
    expect(memoryPeakPath("../../etc")).toBeNull();
  });

  it("reads memory.peak and OOMKilled through the injected seams", async () => {
    const podman = vi.fn(async () => result(
      "/user.slice/libpod-a.scope\nfalse\n",
    ));
    const read = vi.fn(async () => "918552576\n");
    await expect(readContainerResources("agent-a", { podman, read })).resolves.toEqual({
      peakMemoryBytes: 918552576,
      oomKilled: false,
    });
    expect(podman).toHaveBeenCalledWith(
      [
        "inspect",
        "--format",
        "{{.State.CgroupPath}}\n{{.State.OOMKilled}}",
        "agent-a",
      ],
      CONTAINER_RESOURCE_TIMEOUT_MS,
    );
    expect(read).toHaveBeenCalledWith(
      "/sys/fs/cgroup/user.slice/libpod-a.scope/memory.peak",
    );
    expect(podman).toHaveBeenCalledTimes(1);
  });

  it("falls back to Podman's sample only when memory.peak is unavailable", async () => {
    const podman = vi.fn()
      .mockResolvedValueOnce(result("/old.scope\ntrue\n"))
      .mockResolvedValueOnce(result("344064000 / 4294967296\n"));
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const read = vi.fn(async () => { throw missing; });
    await expect(readContainerResources("resolve-1", { podman, read })).resolves.toEqual({
      peakMemoryBytes: 344064000,
      oomKilled: true,
    });
    expect(podman).toHaveBeenNthCalledWith(
      2,
      ["stats", "--no-stream", "--format", "{{.MemUsageBytes}}", "resolve-1"],
      CONTAINER_RESOURCE_TIMEOUT_MS,
    );
  });

  it("keeps unavailable measurements absent rather than inventing zeroes", async () => {
    const podman = vi.fn()
      .mockResolvedValueOnce(result("\nfalse\n"))
      .mockResolvedValueOnce(result("", 125));
    await expect(readContainerResources("gone", {
      podman,
      read: vi.fn(),
    })).resolves.toEqual({ oomKilled: false });
    const uninspectable = vi.fn()
      .mockResolvedValueOnce(result("", 125))
      .mockResolvedValueOnce(result("2048 / 4096"));
    await expect(readContainerResources("uninspectable", {
      podman: uninspectable,
      read: vi.fn(),
    })).resolves.toEqual({ peakMemoryBytes: 2048 });
    expect(uninspectable).toHaveBeenCalledTimes(2);

    await expect(readContainerResources("unmeasurable", {
      podman: async () => result("", 125),
      read: vi.fn(),
    })).resolves.toEqual({});
  });

  it("parses and formats resource fields without rendering a routine false OOM bit", () => {
    expect(parseStatsMemory("1024 / 4096\n")).toBe(1024);
    expect(parseStatsMemory("1.5MB / 4GB")).toBe(1_572_864);
    expect(parseStatsMemory("not available")).toBeUndefined();
    expect(formatContainerResources({ peakMemoryBytes: 1024, oomKilled: false })).toBe(
      "peakMemoryBytes=1024",
    );
    expect(formatContainerResources({ oomKilled: true })).toBe("oomKilled=true");
    expect(mergeContainerResources(
      { peakMemoryBytes: 10, oomKilled: false },
      { peakMemoryBytes: 12, oomKilled: true },
    )).toEqual({ peakMemoryBytes: 12, oomKilled: true });
  });
});
