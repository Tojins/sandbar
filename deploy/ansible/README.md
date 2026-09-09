# Hosting the sandbar daemon

This directory is the host contract (#140): what a Linux box must provide to
run the sandbar daemon unattended, expressed as an Ansible role that provides
it, and the short list of steps a human takes by hand because they carry
secrets. It ships with the package so a consumer repo holds only an
inventory: the contract lives with the code that depends on it, the way the
coding standards do.

Run it from the operator's own machine against the box. There is no deploy
from GitHub Actions, by decision: every sandbar landing pushes the source
branch, so a deploy-on-push would restart the daemon that just landed and
abort its siblings, and an Actions deploy key would be root on the box and
readable by anyone who can edit a workflow.

## What the box gets

Target: **Ubuntu 24.04 or 26.04**. 24.04's podman 4.9 equals the
podman-remote client the gate images bake and 26.04's 5.7 is newer than it,
the safe direction (verified: the 4.9.3 client drives a 5.7 server over the
user socket). Debian 12 ships 4.3, older than the client, and that is the one
direction version skew bites. The role refuses any other release.

The role, `roles/sandbar`, provides:

- rootless **podman** with netavark and aardvark-dns, a subordinate
  uid/gid range for the service user, and a check that the host runs cgroup v2
  with `memory` and `pids` delegated to user managers;
- one **AppArmor** rule, `signal (receive) peer=podman` in passt's `pasta`
  profile, inserted only where Ubuntu's stub `podman` profile is present
  too. Without it podman cannot SIGTERM the rootless-netns pasta at container
  cleanup, every `podman pod rm` fails with `rootless netns: kill network
  process: permission denied`, and sandbar halts on the leaked gate stack
  after its first gate (seen on 26.04.1; Debian #1100135 is the same
  conflict, which Debian resolved by dropping the stub Ubuntu keeps);
- **Node** (major from NodeSource, default 24), **git**, **gh**, and Ubuntu's
  **Caddy** package when the public run UI is enabled;
- a dedicated **`sandbar` user** with linger, so its user manager, its
  `podman.socket` and the daemon unit run with no login session and come back
  after a reboot; git identity and the gh credential helper configured for it;
- a **4 GB swapfile**: Hetzner images ship without swap and sandbar applies no
  memory limits, so an overlap of two builds must degrade to slowness rather
  than an OOM kill of an arbitrary victim;
- **SSH** by key only, and only the keys the inventory lists, for root and
  the service user alike (exclusive: an unlisted key is removed);
- **unattended-upgrades** for security updates, with the automatic reboot
  OFF. A reboot mid-run is the one thing the box must never do on its own;
- a **systemd user unit**, `sandbar.service`, enabled at boot and otherwise
  left to a human. Its body is `roles/sandbar/templates/sandbar.service.j2`,
  table-tested in `src/deploy-unit.test.ts`:
  - `WorkingDirectory` is the consumer checkout and `EnvironmentFile` its
    `sandbar.env`, so the host preflight's `gh auth status` and the pull
    below see `GH_TOKEN`;
  - `ExecStartPre` runs `git pull --ff-only` then `npm ci --no-audit`. Since
    #66 nothing else refreshes the checkout, so every start runs the config
    and the driver origin carries at that moment;
  - `ExecStart` is the consumer's own launch command (default
    `npm run sandbar`);
  - `Restart=no`. Exits 2 (stuck) and 4 (quota) are deliberate stops; a
    human reads why and restarts. No timers, no log sweep, no memory limit.
- a second **systemd user unit**, `sandbar-ui.service`, running the standalone
  `sandbar ui` reader on loopback. It starts after the daemon's refresh and is
  part of the daemon for explicit stops and restarts, but it stays up when the
  daemon crashes so the report can show that crash. It has no install step and
  no automatic restart;
- **Caddy**, enabled as a system service, serving plain HTTP on
  `sandbar_ui_http_port` (default 80) and proxying to the standalone reader on
  `127.0.0.1:sandbar_ui_port` (default 7332). Set `sandbar_ui_port: 0` to
  disable this feature.

What the role deliberately does NOT do: place a secret, clone the checkout,
restart a running daemon, run anything on a schedule, or manage a firewall.

## Running the playbook

On the operator's machine: ansible-core 2.15 or newer and the collections
`ansible.posix` and `community.general` (`ansible-galaxy collection install
ansible.posix community.general`). Then, in a consumer repo or in a copy of
this directory:

```sh
cp inventory.example.yml inventory.yml     # hosts, keys and variables; no secrets
ansible-playbook -i inventory.yml site.yml
```

Every variable is documented in `roles/sandbar/defaults/main.yml`. Three have
no default and the role refuses to run without them: `sandbar_checkout`,
`sandbar_git_email` and `sandbar_operator_ssh_keys`.

The **first** run stops at "Stop unless the checkout was cloned as the
service user": everything system-level is in place and the user exists, and
the next steps carry secrets. Take them, then run the playbook again; it
finishes by installing and enabling the unit. Rerunning at any later time is
safe and reports no changes when nothing moved.

## By hand

As the service user (`ssh sandbar@<box>`; the operator's key is authorized):

1. **Clone the consumer checkout** with the bot's GitHub token. The gh
   credential helper is already configured, so
   `gh auth login --with-token < token` followed by
   `git clone https://github.com/<owner>/<repo> <sandbar_checkout>` needs no
   stored password. A classic token with `repo` scope on a collaborator
   account; a fine-grained token cannot reach a repository owned by another
   user.
2. **`sandbar.env`** in the checkout, mode 0600, holding what the consumer's
   `sandbar.config.mjs` reads with `readEnvFile` — at least `GH_TOKEN`.
3. **Agent logins whose credential is a file.** A role routed to codex needs
   `codex login` ON THE BOX: `ssh -L 1455:localhost:1455 sandbar@<box>`, run
   `codex login`, open the printed URL locally. Never copy an `auth.json`
   between hosts — one refresh-token family cannot be shared (#134). List the
   file in `sandbar_secret_files` so the role checks it.
4. **Rerun the playbook.** It asserts every listed credential exists, is
   owned by the service user and is mode 0600, then installs the unit.

Nothing above enters a repository. Vault ciphertext in a consumer repo is
readable by every developer there, which is the opposite of the point.

## Operating it

All as the service user:

```sh
systemctl --user start sandbar sandbar-ui  # first start, and after a deliberate stop
systemctl --user stop sandbar         # SIGTERM: sandbar's own cleanup, up to sandbar_stop_timeout_sec
systemctl --user status sandbar sandbar-ui
journalctl --user -u sandbar -u sandbar-ui -f
```

The daemon exits 2 after six consecutive issue terminals without a landing
and 4 on provider quota. Both are stops to read, not to retry; start it again
when the cause is handled. A landed change to the config or the gate stack is
picked up at the next start — the unit pulls before it launches — and a
running daemon reports how far behind it is through preflight's stale-config
warning.

The team report is `http://<ip>/`; with a non-default public port, use
`http://<ip>:<sandbar_ui_http_port>/`. It deliberately has no authentication:
it contains only the tracker-visible issue state, compact event prose and
complaints. A host that adds a firewall must allow the public HTTP port.

The daemon's own in-process UI is unchanged: it still binds the consumer
config's loopback `uiPort` (default 7331), and dies with that process. An
operator can still reach that copy with
`ssh -L 7331:127.0.0.1:7331 sandbar@<box>` and open `http://127.0.0.1:7331`.
The Caddy-backed report instead comes from `sandbar-ui.service`, whose
`--port` must differ from the daemon's `uiPort`.

Reinstalling the box: run the playbook, take the by-hand steps, start. The
`.sandbar` workdir under the checkout is a cache; losing it costs agent time,
never correctness.

## Validating a change to the role

```sh
ansible-lint --profile production site.yml
ansible-playbook -i inventory.yml --syntax-check site.yml
ansible-playbook -i inventory.yml --check site.yml      # against a real box
```

For a full run without a box, a systemd-enabled Ubuntu container of either
release is enough, with three inventory overrides: `ansible_connection:
containers.podman.podman` (collection `containers.podman`),
`sandbar_swap_size_mb: 0` (a container may not `swapon`), and a subordinate
range that fits inside the container's own uid space when podman is itself
rootless (for example `sandbar_subid_start: 10000`, `sandbar_subid_count:
50000`). Expect the first run to stop at the checkout assertion; create the
checkout and 0600 placeholder files as the service user and rerun. A third
run must report `changed=0`.

```sh
podman build -t sandbar-host-test - <<'CF'
FROM docker.io/library/ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus python3 sudo iproute2 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
CF
podman run -d --name sandbar-host-test --privileged --systemd=always sandbar-host-test
```
