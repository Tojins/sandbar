# The one image sandbar's self-hosted run needs, serving BOTH roles (#39).
#
#   - the agent sandbox, whose uid-1000 user and driver tools are supplied by
#     sandbar's generated augmentation layer;
#   - the gate stack's `runner`, which lives in a podman POD, where keep-id is
#     impossible. There, container root is what maps back to the invoking user,
#     so the image's default USER is deliberately left as root and no `USER`
#     directive appears below. `checkWorktreeImageUids` probes exactly this and
#     refuses the run if it changes.
#
# glibc, not alpine, and that is not a preference. `node_modules` is installed
# on the HOST by the `onWorktreeReady` hook into the gated worktree and reaches
# both containers through the bind mount, so vitest's esbuild/rollup binaries
# are the host's `linux-x64-gnu` builds. A musl base would fail to load them.
# The node MAJOR is pinned to the host's for the same reason.
FROM docker.io/library/node:24-bookworm-slim

# git: the agent commits, and a good half of the suite drives real repos.
# ca-certificates/curl: TLS for the agent's own network reads.
# procps: the suite's SIGKILL-reaping assertions read process state.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        procps \
    && rm -rf /var/lib/apt/lists/*

# The podman REMOTE client (#48). The gate runner reaches the HOST's podman
# through a socket mounted into it, and `CONTAINER_HOST` alone switches this
# binary to remote mode — no `--remote`, no containers.conf — so `RUNTIME =
# "podman"` stands and not one `execFile(RUNTIME, …)` in sandbar or in the
# suite changes. That is what buys the ~35 podman tests that used to skip in the
# gate, silently, green either way.
#
# The static release binary rather than Debian's package: bookworm ships no
# `podman-remote` at all, and its `podman` is 4.3.1 dragging ~60 MB of runtime
# dependencies (conmon, crun, netavark, the storage stack) that a remote client
# never executes. This is one 21 MB file.
#
# PINNED, unlike claude-code below, and the difference is not taste: that is a
# tool the agent uses, this is a protocol client talking to a server whose
# version it does not choose. Skew bites only when the client is NEWER than the
# server, so a pin drifts in the SAFE direction — it keeps working against a
# host that upgrades. Deriving the host's version at config load and passing it
# as a `buildArgs` entry is self-maintaining and was rejected: it puts the image
# fingerprint (#37) downstream of the host's podman package, so a routine
# `apt upgrade` triggers a rebuild mid-backlog, against a failure that needs a
# major-version bump to appear.
#
# In the agent-sandbox role no socket is mounted and `CONTAINER_HOST` is unset,
# so this binary reaches nothing. Inert, and cheaper than a second image.
RUN curl -fsSL https://github.com/containers/podman/releases/download/v4.9.3/podman-remote-static-linux_amd64.tar.gz \
      | tar xz -C /tmp \
    && install -m0755 /tmp/bin/podman-remote-static-linux_amd64 /usr/bin/podman \
    && rm -rf /tmp/bin

# No agent CLI is installed here. The driver appends the routed providers, at
# its own pins, after resolving this image (#75) — `AGENT_PROVIDER_PACKAGES` in
# src/agent-providers.ts — and `sandbar.pin` now names a release that does. Do
# not re-add a host copy: an unpinned one drifts from the parser the driver
# couples to, and the driver's install wins over it anyway. What this image
# still owes the augmentation is only the ordinary dev-image contract described
# in README.md; the standalone CLIs need no Node/npm runtime from this image.

# No `ENV HOME`: the sandbox provider sets HOME=/home/agent itself, and the
# gate runner is root, whose /root is the right answer for it.
ENV GIT_PAGER=cat \
    PAGER=cat
