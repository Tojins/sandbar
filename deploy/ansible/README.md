# Hosting sandbar daemons

This directory is the host contract for running several independent sandbar
daemons on one Ubuntu box (#140, #149): **one neutral recipe in your repo, one
installation directory on the box, one inventory entry**.

The consumer repository keeps only the development/test container recipe and
files that recipe needs. It need not have a sandbar dependency, config, script,
pin, environment file, or gitignore rule. The installation entry gives that
repository its own Linux user; the role clones it at `~/<project>` and adds
`/.sandbar/` to that clone's `.git/info/exclude`.

The user's private `~/installation/` holds:

- `sandbar.config.mjs`, which imports helpers from `"sandbar"` and explicitly
  sets `cwd` to the consumer clone;
- `sandbar.env`, mode `0600`;
- any files the config maps into worktrees with `{ from, to }` entries; and
- `driver/`, the disposable install of the inventory's exact driver tag.

`installations/outdoor/` and `installations/sandbar/` are the real source
copies deployed by `inventory.yml`. `config_src` is optional: when present the
role copies that directory into `~/installation/`; when absent, `scp`, another
Ansible role, or a clone may place the same files. The role always creates the
directory and always asserts `sandbar.config.mjs` and `sandbar.env` exist,
naming a missing path before it installs either unit.

## What the role provides

The target is Ubuntu 24.04 or 26.04. Host-global work runs once: packages,
Node 24, git, gh, AppArmor's podman/pasta interoperability rule, cgroup-v2
delegation, swap, key-only SSH, unattended security upgrades without automatic
reboots, and Caddy.

For every `sandbar_installations` entry the role provides:

- a Linux user named by `user`, with a disjoint subuid/subgid range, linger,
  its own rootless Podman storage and `podman.socket`;
- the consumer clone at `/home/<user>/<project>`;
- `/home/<user>/installation` and the optional `config_src` copy;
- `sandbar.service` and `sandbar-ui.service` in that user's systemd session.

Unit names can remain identical because systemd user sessions are separate.
The daemon has one `ExecStartPre`: the role-owned installer reconciles
`~/installation/driver/` to the exact `github:owner/repo#vX.Y.Z` tag and stamps
it only after the CLI exists. A matching stamp does no network or npm work; a
changed tag installs; a failed install removes the old stamp and fails the
start instead of launching old bytes. `ExecStart` runs that driver's CLI with
`--config ~/installation/sandbar.config.mjs`. It does not `git pull` or `npm
ci` the consumer tree.

The UI unit runs the same driver's `ui` command on the entry's `reader_port`.
Both units use `Restart=no`; exits 2 and 4 remain stops for a human to inspect.
Until prefix routing lands in #150, Caddy serves the first installation's
reader at `/`.

## Inventory

`sandbar_installations` is a list. Every entry requires `user`, `project`,
`clone_url`, and a positive `reader_port`. `driver_tag` overrides the box-level
`sandbar_driver_tag`; both accept exact tags only. `config_src` is optional.

```yaml
sandbar_driver_tag: github:Tojins/sandbar#v0.40.1
sandbar_installations:
  - user: outdoor
    project: outdoor
    clone_url: https://github.com/Tojins/outdoor.git
    reader_port: 7332
    config_src: "{{ inventory_dir }}/installations/outdoor"
  - user: sandbar
    project: sandbar
    clone_url: https://github.com/Tojins/sandbar.git
    driver_tag: github:Tojins/sandbar#v0.40.1
    reader_port: 7333
    config_src: "{{ inventory_dir }}/installations/sandbar"
```

The sandbar installation's tag must lag its checkout. A regression in the
current checkout must not also become the driver responsible for repairing
it; `inventory.yml` records that rule beside the override.

## First deployment and secrets

Install ansible-core 2.15 or newer plus `ansible.posix` and
`community.general`, then run from this directory:

```sh
ansible-galaxy collection install ansible.posix community.general
SANDBAR_OPERATOR_SSH_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
  ansible-playbook -i inventory.yml site.yml
```

The account and directory passes cover every installation before the play
reaches its expected missing-file refusal. Place secrets once per installation,
as that installation's user:

1. Create `~/installation/sandbar.env` with mode `0600`. It contains `GH_TOKEN`,
   provider credentials, and optional `SANDBAR_*` routing values consumed by
   `splitRoleRouting`.
2. Run `gh auth login`. This is per user; it also lets the role clone a private
   consumer on the next play.
3. Run `codex login` when any role is routed to Codex. Keep the resulting
   `~/.codex/auth.json` under this user. Never copy it between users or hosts:
   each workdir reconciles one token family and two daemons sharing a login can
   rotate each other stale.

Then rerun the play. It copies configured installation sources, checks the
hand-placed env files, clones/updates both consumers, installs and enables both
unit pairs. It never starts or restarts a daemon during a deploy.

## Operating an installation

SSH as the installation user, then:

```sh
systemctl --user start sandbar
systemctl --user stop sandbar
systemctl --user status sandbar sandbar-ui
journalctl --user -u sandbar -u sandbar-ui -f
```

Moving `driver_tag` and restarting is the driver deploy. Changing
`config_src`, rerunning the play, and restarting is the config deploy. A stop
uses `KillMode=control-group`, `ExitType=cgroup`, and a 900-second default
timeout so the driver can release containers, pods, the wake lock, and the
origin lease. Restarts remain deliberate human actions; there are no timers,
automatic retries, log sweeps, memory limits, GitHub Actions deploys, or
automatic reboots.

## Validation

```sh
ansible-lint --profile production site.yml
ansible-playbook -i inventory.yml --syntax-check site.yml
ansible-playbook -i inventory.yml --check site.yml
```

`src/deploy-unit.test.ts` renders both unit templates for the two real
installation shapes. `src/deploy-driver-install.test.ts` pins the matching,
changed, and failed stamp paths. A third play against a configured box must
report `changed=0`.
