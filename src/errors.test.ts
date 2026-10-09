import { describe, expect, it } from "vitest";

import {
  SandbarError,
  hasExitCode,
  isErrno,
  isExitCode,
  isExitStatus,
  isForgeTransportFailure,
} from "./errors.js";

describe("error condition predicates", () => {
  it("recognizes the child-process and errno shapes", () => {
    expect(isExitCode({ code: 128 }, 128)).toBe(true);
    expect(hasExitCode({ code: 1 })).toBe(true);
    expect(isErrno({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(isExitStatus({ status: 1 }, 1)).toBe(true);
  });

  it("rejects primitives and mismatched property types without throwing", () => {
    for (const err of [null, undefined, "failure", 128, { code: "128" }]) {
      expect(isExitCode(err, 128)).toBe(false);
      expect(hasExitCode(err)).toBe(false);
    }
  });
});

describe("isForgeTransportFailure", () => {
  const ghFailure = (stderr: string) =>
    Object.assign(new Error(`Command failed: gh issue list\n${stderr}`), {
      code: 1,
      stderr,
    });

  it("classifies a gh request that never got an HTTP answer", () => {
    for (const stderr of [
      "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n",
      'Post "https://api.github.com/graphql": read tcp 10.0.0.2:51234->140.82.121.6:443: read: connection reset by peer\n',
      'Post "https://api.github.com/graphql": dial tcp 140.82.121.6:443: i/o timeout\n',
      'Get "https://api.github.com/repos/o/r": net/http: TLS handshake timeout\n',
    ]) {
      expect(isForgeTransportFailure(ghFailure(stderr))).toBe(true);
    }
  });

  it("follows the cause chain through a wrapping SandbarError", () => {
    const wrapped = new SandbarError("Could not read the reviews", {
      cause: ghFailure("error connecting to api.github.com\n"),
    });
    expect(isForgeTransportFailure(wrapped)).toBe(true);
  });

  it("leaves forge answers and unrelated failures fatal", () => {
    for (const err of [
      ghFailure("HTTP 401: Bad credentials (https://api.github.com/graphql)\n"),
      ghFailure("HTTP 502: Bad Gateway (https://api.github.com/graphql)\n"),
      ghFailure("GraphQL: Could not resolve to a Repository with the name 'o/r'.\n"),
      new Error("Command failed: gh issue comment --body error connecting to api.github.com"),
      new SyntaxError("Unexpected token"),
      null,
      "error connecting to api.github.com",
    ]) {
      expect(isForgeTransportFailure(err)).toBe(false);
    }
  });
});
