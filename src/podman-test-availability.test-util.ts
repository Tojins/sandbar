// Whether the podman-backed test files RUN, and what it means when they do not
// (#48).
//
// Until #48 the answer was one shape: `describe.runIf(podman image exists)`,
// silently false wherever podman was missing. That is right on a developer
// machine — a contributor with no podman should not have a red suite — and it
// is exactly wrong in the gate runner, which now HAS a podman (the host's, over
// a mounted socket) and whose whole reason for having one is that ~35 tests
// pinning the podman layer used to skip there without saying so. Restore the
// silent skip in the gate and #48 is reopened with nobody noticing: the socket
// breaks on a podman upgrade, a uid change, or a `podman.socket` that was not
// enabled after a reboot, and the gate goes green over a layer it never
// touched.
//
// So the availability answer is a THREE-way decision, and the third arm is the
// point: `fail` registers a failing test where `skip` would have registered
// nothing. `SANDBAR_REQUIRE_PODMAN_TESTS=1` — set in the gate container's env,
// unset everywhere else — is what selects it.
//
// TWO AXES, AND CONFLATING THEM MAKES THE GATE PERMANENTLY RED. "podman is
// unreachable" is a fault: required-and-failing in the gate. "the client is not
// local" is a fact about where the suite is running: the gate drives podman
// through a socket, so a test that pins what a LOCAL client does (its signal
// semantics, its loopback topology) is not a test the gate can run at all, and
// its file skips even under the flag. See gate-stack-hostpodman.test.ts, which
// is the only file that asks for the local axis.
//
// A CONTRADICTION IS A FAILURE, NOT A CHOICE. `SANDBAR_SKIP_PODMAN_TESTS=1`
// alongside the require flag is not an opt-out to honour; it is a run that has
// been told both things, and picking either silently is how a required suite
// ends up skipping. It fails, naming both variables.
//
// The decision is a pure function so the gate — which cannot observe its own
// wiring, the config it runs under having been fixed at launch — can still
// prove the policy. The probe and the test registration are the thin shell.
//
// `.test-util.ts` shares `*.test.ts`'s tsconfig exclusion: without it this
// compiles into `dist/` and ships as importable dead weight.

import { execFileSync } from "node:child_process";

import { it } from "vitest";

import { RUNTIME } from "./runtime.js";

export type PodmanTestDecision =
  | { readonly kind: "run" }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

export type PodmanTestInputs = {
  // What is being decided about, for the message: "gate-stack podman tests".
  readonly what: string;
  // Whether podman answered, and if not, why not.
  readonly probe:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string };
  readonly skipRequested: boolean;
  readonly required: boolean;
  // This file pins what a LOCAL podman client does, so a remote one cannot
  // stand in for it.
  readonly needsLocalClient: boolean;
  readonly clientIsLocal: boolean;
};

export function decidePodmanTests(input: PodmanTestInputs): PodmanTestDecision {
  // FIRST, before anything the require flag touches: a remote client is not a
  // broken podman, it is a different podman, and the facts these files pin are
  // about the local one. Failing here would make the gate red forever.
  if (input.needsLocalClient && !input.clientIsLocal) {
    return {
      kind: "skip",
      reason:
        `skipping ${input.what}: they pin what a LOCAL ${RUNTIME} client does ` +
        "and CONTAINER_HOST is set, so this process drives a remote one. Run " +
        "them on the host.",
    };
  }
  if (input.required && input.skipRequested) {
    return {
      kind: "fail",
      reason:
        `${input.what}: SANDBAR_REQUIRE_PODMAN_TESTS=1 and ` +
        "SANDBAR_SKIP_PODMAN_TESTS=1 are both set. They ask for opposite " +
        "things, and honouring either silently is how a required suite ends " +
        "up skipping. Unset one.",
    };
  }
  if (input.skipRequested) {
    return {
      kind: "skip",
      reason: `skipping ${input.what}: SANDBAR_SKIP_PODMAN_TESTS=1.`,
    };
  }
  if (!input.probe.ok) {
    const reason = `${input.what}: ${input.probe.reason}`;
    return input.required
      ? {
          kind: "fail",
          reason:
            `${reason}\nSANDBAR_REQUIRE_PODMAN_TESTS=1 is set, so this is a ` +
            "FAILURE rather than a skip: something that was supposed to have " +
            "a podman does not. In the gate runner that is the mounted socket " +
            "(check `podman.socket` on the host, the socket path in " +
            "sandbar.config.mjs, and CONTAINER_HOST in the container).",
        }
      : { kind: "skip", reason: `skipping ${reason}` };
  }
  return { kind: "run" };
}

// The shell: probe podman, decide, and make the decision observable — a warning
// for a skip, a REGISTERED FAILING TEST for a fault. Returns what
// `describe.runIf` wants.
//
// Called at collection time, never from a hook: vitest evaluates `runIf` while
// building the suite, so a flag set in `beforeAll` arrives too late and
// silently skips everything — a test file that passes by never running.
export function podmanTestsEnabled(opts: {
  readonly what: string;
  // Any image the file needs present. `image exists` is also the cheapest
  // proof that the client can reach a daemon at all.
  readonly image: string;
  readonly needsLocalClient?: boolean;
}): boolean {
  // No `env` seam, deliberately: `decidePodmanTests` above IS the seam, and it
  // is where the policy this module exists for is proved. An injectable
  // environment here would only let a test re-read `process.env` through a
  // different name.
  const env = process.env;
  const probe = ((): PodmanTestInputs["probe"] => {
    try {
      execFileSync(RUNTIME, ["image", "exists", opts.image], {
        stdio: "ignore",
      });
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason:
          `${RUNTIME} or ${opts.image} unavailable ` +
          `(\`${RUNTIME} pull ${opts.image}\` to enable them)`,
      };
    }
  })();

  const decision = decidePodmanTests({
    what: opts.what,
    probe,
    skipRequested: env["SANDBAR_SKIP_PODMAN_TESTS"] === "1",
    required: env["SANDBAR_REQUIRE_PODMAN_TESTS"] === "1",
    needsLocalClient: opts.needsLocalClient ?? false,
    // A remote client is selected by CONTAINER_HOST alone — no `--remote`, no
    // containers.conf — which is what lets every `execFile(RUNTIME, …)` in
    // sandbar and in these files stay exactly as it was.
    clientIsLocal: (env["CONTAINER_HOST"] ?? "") === "",
  });

  if (decision.kind === "fail") {
    // Registered rather than thrown: a throw during collection fails the FILE
    // with a stack trace about an import, while a failing test names the
    // problem in the runner's own summary — which is where a human reading a
    // gate trace is looking.
    it(`${opts.what} must be available`, () => {
      throw new Error(decision.reason);
    });
    return false;
  }
  if (decision.kind === "skip") console.warn(decision.reason);
  return decision.kind === "run";
}
