# Hosting sandbar daemons

This directory is the host contract for running several independent sandbar
daemons on one Ubuntu box (#140, #149): **one neutral recipe in your repo, one installation directory on the box, one inventory entry**.

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
reboots, the operator VPN, and Caddy.

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
It requires and starts after a successful daemon activation, so a failed driver
install cannot launch a stale reader; `PartOf=` carries deliberate daemon stops
and restarts to it, while a later daemon crash leaves the report available.
Each installation config must also give the daemon's in-process `uiPort` its
own host port, distinct from every reader; the two committed configs use 7331
and 7334 around their inventory's 7332 and 7333.
Both units use `Restart=no`; exits 2 and 4 remain stops for a human to inspect.
Caddy serves a static index of installation projects at `/` (a rendered file,
since Ubuntu's packaged Caddy 2.6 has no heredocs); each link opens that
installation's reader at `/<project>/`. That site answers on the tunnel address
alone — see below — and logs every request, successful ones included, to
`sandbar_ui_access_log`.

## Reaching the run UI

The run UI is an operator surface (#155). What it renders is a private
consumer's issue titles, branch names, agent speech, parked-issue causes and
attempt log paths, so it is not served to the internet: the role runs an
OpenVPN server whose only reach is this box, Caddy binds to the tunnel address
(`sandbar_vpn_address`, 10.8.0.1 by default) and nothing on the public
interface answers but SSH and that server. The box forwards nothing and the
server pushes no route or DNS, so a connected client can reach the tunnel
subnet and nothing else; the readers themselves stay on loopback.

SSH deliberately stays public and key-only. A broken VPN must not lock the
operator out of the box that would repair it.

The certificate authority lives here, under root, and is the one piece of this
the play does not own past its first run. `/usr/local/sbin/sandbar-vpn` is the
whole interface:

```sh
sandbar-vpn issue tojins-laptop > tojins-laptop.ovpn   # one device
sandbar-vpn revoke tojins-laptop                       # that device alone
```

Profiles are named `<person>-<machine>` and carry everything inline. Hand one
over out of band and import it; the UI is then at
`http://10.8.0.1/` with one link per installation. Devices are never inventory
data — `Tojins/sandbar` is public and `inventory.yml` is committed there — so
the reachable set grows by issuing another profile, never by a role or
inventory change. A revocation takes effect on that device's next connection;
restart `openvpn-server@sandbar` to drop a session already up.

The role initialises the PKI once, guarded by the server certificate it
creates, so a repeat play does no work. Removing `/etc/openvpn/sandbar/pki`
means a new CA and dead profiles for every device; reissue them all.

## Inventory

`sandbar_installations` is a list. Every entry requires a safe Linux `user`, a
single path-component `project`, `clone_url`, and a unique integer
`reader_port` from 1 through 65535. Users are unique too. `driver_tag` overrides
the box-level `sandbar_driver_tag`; both accept exact tags only. Projects are
unique because each names its Caddy route. `config_src` is optional.

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

Issue one VPN profile per device as root, once each, and hand it over out of
band; nothing reaches the run UI before that. See *Reaching the run UI* above.

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
installation shapes, and pins the site address Caddy answers on together with
the reach the VPN server grants. It also RUNS `sandbar-vpn` as the role
renders it, against stub easy-rsa, openssl, openvpn and install commands in a
throwaway tunnel directory, so the device lifecycle and the profile it prints
are exercised rather than read. `src/deploy-driver-install.test.ts` pins the
matching, changed, and failed stamp paths. A third play against a configured
box must report `changed=0`; PKI initialisation and device profiles are
one-time actions guarded out of that count.
