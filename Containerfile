# The one image sandbar's self-hosted run needs, serving BOTH roles (#39).
#
#   - the agent sandbox, run as `--user 1000:1000 --userns=keep-id:uid=1000,
#     gid=1000` (see agent-sandbox.ts), which is why an `agent` user must exist
#     at uid/gid 1000 with a writable /home/agent;
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
# sudo: `sandboxHooks.sandbox.onSandboxReady` entries may set `sudo: true`.
# ca-certificates/curl: TLS for the agent's own network reads.
# procps: the suite's SIGKILL-reaping assertions read process state.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        procps \
        sudo \
    && rm -rf /var/lib/apt/lists/*

# node:*-slim already ships a `node` user AT uid/gid 1000, so the agent user is
# a rename rather than a `useradd` — which would fail with the uid taken, and
# the uid is the part that has to be 1000.
RUN groupmod -n agent node \
    && usermod -l agent -d /home/agent -m node \
    && printf 'agent ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent

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

# Unpinned on purpose: the image is rebuilt only when this file's bytes change
# (it declares no `rebuildOn`, since it bakes no dependency of the repo), so a
# pin here would be a version nobody revisits rather than a reproducible one.
#
# `--allow-scripts` is not optional hygiene. npm >= 11 blocks lifecycle scripts
# by default and only WARNS, so the package's `postinstall` is skipped and the
# build still succeeds — today's version happens to work without it, which is
# exactly what would make a future version's silent breakage look like an agent
# failure rather than an image one.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code

# No `ENV HOME`: the sandbox provider sets HOME=/home/agent itself, and the
# gate runner is root, whose /root is the right answer for it.
ENV GIT_PAGER=cat \
    PAGER=cat
