// The container runtime, in one place.
//
// Hard-coded rather than configurable: sandbar depends on podman-specific
// behaviour that has no docker equivalent — pods (#24), `--userns=keep-id` in
// the agent sandbox, and rootless uid mapping where container root writes as
// the invoking user. A `docker` value would type-check and then fail at the
// first `pod create`, so the constant is the honest statement of the
// dependency.
export const RUNTIME = "podman";
