# Hosting sandbar daemons

This directory is the host contract for running several independent sandbar
daemons on one Ubuntu box (#140, #149), and the deployment channel that keeps
them current (#146): **one neutral recipe in your repo, one installation
directory on the box, one entry in `group_vars/all.yml`**.

**A commit on `main` of this repository is the deploy.** The box pulls it every
five minutes and applies it to itself; no laptop, no hand-run play, no
hand-timed restart in steady state. Rolling back is a `git revert` on main,
applied by the same channel. The laptop play is bootstrap only: it provisions a
fresh box and installs the timer that takes over from it.

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
- `restart-requested`, only while a restart the play asked for is pending.

`installations/outdoor/` and `installations/sandbar/` are the real source
copies deployed by `group_vars/all.yml`. `config_src` is optional: when present
the role copies that directory into `~/installation/`; when absent, `scp`,
another Ansible role, or a clone may place the same files. The role always
creates the directory and always asserts `sandbar.config.mjs` and `sandbar.env`
exist, naming a missing path before it installs either unit.

## What the role provides

The target is Ubuntu 24.04 or 26.04. Host-global work runs once: packages,
Node 24, git, gh, AppArmor's podman/pasta interoperability rule, cgroup-v2
delegation, swap, key-only SSH, unattended security upgrades without automatic
reboots, the operator VPN, Caddy, the driver build, and the convergence
timer.

For every `sandbar_installations` entry the role provides:

- a Linux user named by `user`, with a disjoint subuid/subgid range, linger,
  its own rootless Podman storage and `podman.socket`;
- the consumer clone at `/home/<user>/<project>`;
- `/home/<user>/installation` and the optional `config_src` copy;
- `sandbar.service` and `sandbar-ui.service` in that user's systemd session.

Unit names can remain identical because systemd user sessions are separate.

## The driver is main's build

`tasks/driver.yml` keeps the box's own clone of this repository at
`/opt/sandbar/src`, builds each commit it finds into
`/opt/sandbar/builds/<sha>` with `npm ci && npm run build`, and moves the
`/opt/sandbar/current` symlink only once that build produced a `dist/cli.js`.
A failed build fails the play before the link moves and before any daemon is
asked to restart. Both units' `ExecStart` names `current`, so a running daemon
never sees its own `dist/` change under it — a restart is what switches to a new
build — and the previous build stays on disk so a revert lands on bytes that are
already there.

That clone is deliberately not the one `ansible-pull` owns: updating the tree a
running play is being read from would let a mid-play landing swap a task file
that is about to be included. It is updated in the same play, before the
installation configs are copied, so the driver is never older than the config it
will read.

Exact driver tags, `~/installation/driver/` and the unit's `ExecStartPre` are
gone with this, as is the rule that this repository's own installation had to
lag its checkout: config and driver now arrive in the same commit, and a bad
landing costs one revert rather than a bricked loop. `requiresSandbar` still
applies to `npm i -D sandbar` consumers.

## Restarting a daemon at a moment it chooses

The play never restarts a daemon itself: a restart while an issue is running or
landing aborts that work. Whenever it changed the built driver, an
installation's files or either of its units, it writes the applied commit to
`~/installation/restart-requested` instead.

The daemon reads that file at the top of every recompute. It then **drains** —
stops admitting, keeps landing every pending terminal and every landable `land`
request — and exits 75 once nothing is running, ongoing or landing. The unit's
`RestartForceExitStatus=75` turns exactly that exit back into a start; `Restart=no`
stays, so exits 1, 2 and 4 remain stops for a human to inspect. The new process
removes that request at startup, so the exit cannot repeat — and only that one:
a play that lands the next commit while a daemon is still starting leaves a
request the daemon honours instead of deleting, so no commit is skipped.

A daemon that is stopped is left stopped, and its request simply waits for the
next start. Host-level changes — packages, AppArmor, Caddy — apply as soon as
the play runs: unattended security upgrades already replace packages under a
running daemon, so a box-wide freeze would not buy an invariant this box has,
and it would couple the installations' queues.

## Convergence and visibility

`tasks/pull.yml` installs `/usr/local/bin/sandbar-pull` plus a
`sandbar-pull.timer` that runs it every five minutes as root. The script runs
`ansible-pull --only-if-changed` against `main` into `/var/lib/sandbar/deploy`
and applies `deploy/ansible/site.yml` to `localhost`. No credential is needed:
the repository is public. A push channel was rejected because root-level changes
are in scope and a push would need a root key in Actions secrets; the reconciler
is deliberately not sandbar, so a landed regression that bricks a daemon cannot
also disable the thing that applies the revert.

**Recorded exposure:** whoever lands on main is root on the box, including the
daemon's own bot identity. The control is that a `deploy/` change is a reviewed
landing here — the gate suite, the reviewer, the operator's triage of every
issue, and `src/deploy-unit.test.ts`, which pins the unit strings, the timer,
the restart contract and the installation data shape in every gate.

Every attempt, successful or not, rewrites `/var/www/sandbar/deploy.json` with
the commit, the time and the result, and the Caddy index page at `/` renders it
beside the installation links. A box stuck on an old commit therefore says so;
a stale timestamp means the timer itself stopped.

The UI unit runs the same driver's `ui` command on the entry's `reader_port`,
and it is the one thing the play does restart: a reader aborts no work by being
restarted, systemd's automatic restart of the daemon does not propagate to it,
and a reader left on an older build is the page an operator reads. It carries no
`Requires=` for exactly that reason — restarting it must not pull a
deliberately stopped daemon back up. `PartOf=` still carries deliberate daemon
stops and restarts to it, and a daemon crash still leaves the report available.
Each installation config must also give the daemon's in-process `uiPort` its
own host port, distinct from every reader; the two committed configs use 7331
and 7334 around the installation list's 7332 and 7333.
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
data — `Tojins/sandbar` is public and this directory is committed there — so
the reachable set grows by issuing another profile, never by a role or
inventory change. A revocation takes effect on that device's next connection;
restart `openvpn-server@sandbar` to drop a session already up.

The role initialises the PKI once, guarded by the server certificate it
creates, so a repeat play does no work. Removing `/etc/openvpn/sandbar/pki`
means a new CA and dead profiles for every device; reissue them all.

## Installations

`sandbar_installations` lives in `group_vars/all.yml`, beside `site.yml`,
because the box's own pull runs with a one-host inventory (`-i localhost,`) and
has no `inventory_dir` to anchor anything to. Ansible loads playbook-adjacent
`group_vars/` in both channels, so both read the same list.

Every entry requires a safe Linux `user`, a single path-component `project`,
`clone_url`, and a unique integer `reader_port` from 1 through 65535. Users and
projects are unique too — each project names a Caddy route. `config_src` is
optional and is anchored at `playbook_dir`.

```yaml
sandbar_installations:
  - user: outdoor
    project: outdoor
    clone_url: https://github.com/Tojins/outdoor.git
    reader_port: 7332
    config_src: "{{ playbook_dir }}/installations/outdoor"
```

`inventory.yml` holds only the host the bootstrap connects to.

## Bootstrapping a fresh box, and secrets

Install ansible-core 2.15 or newer plus `ansible.posix` and
`community.general`, then run from this directory:

```sh
ansible-galaxy collection install ansible.posix community.general
SANDBAR_OPERATOR_SSH_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
  ansible-playbook -i inventory.yml site.yml
```

The box remembers that public key at `/etc/sandbar/operator-ssh-keys`, because
an unattended pull has none of the operator's environment and a key list that
came out empty there would strip every key off root. The key list stays
exclusive: a key not remembered is removed.

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
hand-placed env files, clones both consumers, builds the driver, installs and
enables both unit pairs, and finally installs the convergence timer — last, so
its first firing cannot land in the middle of the bootstrap. Start each daemon
once by hand; from then on the box owns both the code and the restarts.

A box already running the previous exact-tag scheme needs that same one hand
restart per daemon, once: its daemon predates the request file and will not read
one. Everything after that is automatic, and `~/installation/driver/` can be
removed by hand afterwards — nothing references it.

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

Root-level convergence is `systemctl status sandbar-pull.timer` and
`journalctl -u sandbar-pull`. A stop uses `KillMode=control-group`,
`ExitType=cgroup`, and a 900-second default timeout so the driver can release
containers, pods, the wake lock, and the origin lease. There are no automatic
retries on exits 1, 2 and 4, no log sweeps, no memory limits, no GitHub Actions
deploy, and no automatic reboots.

## Validation

```sh
ansible-lint --profile production site.yml
ansible-playbook -i inventory.yml --syntax-check site.yml
ansible-playbook -i inventory.yml --check site.yml
```

`src/deploy-unit.test.ts` renders every template for the two real installation
shapes. It pins the driver build, the restart contract and the timer, and the
site address Caddy answers on together with the reach the VPN server grants. It
also RUNS `sandbar-vpn` as the role renders it, against stub easy-rsa, openssl,
openvpn and install commands in a throwaway tunnel directory, so the device
lifecycle and the profile it prints are exercised rather than read. A third play
against a configured box must report `changed=0`; PKI initialisation and device
profiles are one-time actions guarded out of that count.
