// The container runtime, in one place.
//
// Hard-coded rather than configurable: sandbar depends on podman-specific
// behaviour that has no docker equivalent — pods (a shared network namespace
// created before any container and surviving every container's removal, #24),
// `--userns=keep-id` in the agent sandbox, and rootless uid mapping where
// container root writes as the invoking user. A `docker` value would type-check
// and then fail at the first `pod create`, so the constant is the honest
// statement of the dependency.
//
// It lives in its own module because everything that shells out to the runtime
// needs it — the gate stack, the sandbox, the orphan sweeper, image builds,
// preflight, the merger — and importing it from any one of those made an
// arbitrary module (previously `db-sidecar.ts`) the de-facto root of the
// dependency graph.
export const RUNTIME = "podman";
