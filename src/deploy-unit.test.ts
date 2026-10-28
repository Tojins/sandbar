// The per-installation systemd units, the convergence timer, the operator VPN,
// the database volume, dump drops and base import, and the host-global role
// shipped by deploy/ansible (#149, #155, #146, #200, #201). Tests
// parse the committed group_vars, render the units, the Caddy site, the index
// page and the VPN server from the real entries, and inspect bounded Ansible
// tasks so deleting one loop or include cannot be hidden by a later task with
// similar text.
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { EXIT_CODE_RESTART } from "./exit-conditions.js";
import { RESTART_REQUEST_FILE } from "./restart-request.js";
import { compareVersions, parseVersion } from "./requires-sandbar.js";

const ROLE = new URL("../deploy/ansible/roles/sandbar/", import.meta.url);
const DEPLOY_ROOT = new URL("../deploy/ansible/", import.meta.url);
const daemonTemplate = readFileSync(new URL("templates/sandbar.service.j2", ROLE), "utf8");
const uiTemplate = readFileSync(new URL("templates/sandbar-ui.service.j2", ROLE), "utf8");
const dbBaseServiceTemplate = readFileSync(new URL("templates/sandbar-db-base.service.j2", ROLE), "utf8");
const dbBaseTimerTemplate = readFileSync(new URL("templates/sandbar-db-base.timer.j2", ROLE), "utf8");
const dbBaseTasks = readFileSync(new URL("tasks/db-base.yml", ROLE), "utf8");
const pullServiceTemplate = readFileSync(new URL("templates/sandbar-pull.service.j2", ROLE), "utf8");
const pullTimerTemplate = readFileSync(new URL("templates/sandbar-pull.timer.j2", ROLE), "utf8");
const pullScriptTemplate = readFileSync(new URL("templates/sandbar-pull.sh.j2", ROLE), "utf8");
const caddyTemplate = readFileSync(new URL("templates/Caddyfile.j2", ROLE), "utf8");
const indexTemplate = readFileSync(new URL("templates/index.html.j2", ROLE), "utf8");
const roleDefaultsSource = readFileSync(new URL("defaults/main.yml", ROLE), "utf8");
const mainTasks = readFileSync(new URL("tasks/main.yml", ROLE), "utf8");
const accountTasks = readFileSync(new URL("tasks/account.yml", ROLE), "utf8");
const userTasks = readFileSync(new URL("tasks/user.yml", ROLE), "utf8");
const installationTasks = readFileSync(new URL("tasks/installation.yml", ROLE), "utf8");
const prepareTasks = readFileSync(new URL("tasks/prepare-installation.yml", ROLE), "utf8");
const caddyTasks = readFileSync(new URL("tasks/caddy.yml", ROLE), "utf8");
const driverTasks = readFileSync(new URL("tasks/driver.yml", ROLE), "utf8");
const pullTasks = readFileSync(new URL("tasks/pull.yml", ROLE), "utf8");
const vpnTasks = readFileSync(new URL("tasks/vpn.yml", ROLE), "utf8");
const packageTasks = readFileSync(new URL("tasks/packages.yml", ROLE), "utf8");
const dbVolumeTasks = readFileSync(new URL("tasks/db-volume.yml", ROLE), "utf8");
const dbInstallationTasks = readFileSync(new URL("tasks/db-installation.yml", ROLE), "utf8");
const dumpReceiveTemplate = readFileSync(new URL("templates/sandbar-dump-receive.j2", ROLE), "utf8");
const dumpKeysTemplate = readFileSync(new URL("templates/dump-authorized_keys.j2", ROLE), "utf8");
const handlers = readFileSync(new URL("handlers/main.yml", ROLE), "utf8");
const vpnServerTemplate = readFileSync(new URL("templates/openvpn-server.conf.j2", ROLE), "utf8");
const vpnScriptTemplate = readFileSync(new URL("templates/sandbar-vpn.j2", ROLE), "utf8");
const roleDefaults = parse(roleDefaultsSource) as Record<string, unknown>;
const groupVarsSource = readFileSync(new URL("group_vars/all.yml", DEPLOY_ROOT), "utf8");
const inventorySource = readFileSync(new URL("inventory.yml", DEPLOY_ROOT), "utf8");
const outdoorConfigPath = new URL("installations/outdoor/sandbar.config.mjs", DEPLOY_ROOT);
const outdoorpubConfigPath = new URL("installations/outdoorpub/sandbar.config.mjs", DEPLOY_ROOT);
const sandbarConfigPath = new URL("installations/sandbar/sandbar.config.mjs", DEPLOY_ROOT);
const outdoorConfig = readFileSync(outdoorConfigPath, "utf8");
const outdoorpubConfig = readFileSync(outdoorpubConfigPath, "utf8");
const sandbarConfig = readFileSync(sandbarConfigPath, "utf8");
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly version: string };

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const INSTALLATION_LOOP = /\{%\s*for installation in sandbar_installations\s*%\}\n([\s\S]*?)\{%\s*endfor\s*%\}\n/g;
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// What the role's own defaults resolve to. Pinned once below, then spelled as
// literals everywhere else so a rendered unit is read the way systemd reads it.
const DRIVER_CURRENT = "/opt/sandbar/current";
const DRIVER_BRANCH = "main";
const DRIVER_REPO = "https://github.com/Tojins/sandbar.git";
const PULL_DIR = "/var/lib/sandbar/deploy";
const PULL_INTERVAL = "5min";
const UI_ROOT = "/var/www/sandbar";
const DEPLOY_STATUS = "deploy.json";

type InventoryInstallation = {
  readonly user: string;
  readonly project: string;
  readonly clone_url: string;
  readonly reader_port: number;
  readonly subid_slot: number;
  readonly config_src?: string;
  readonly dump_drop?: {
    readonly user: string;
    readonly push_key: string;
    readonly push_from?: string;
  };
};

type GroupVars = {
  readonly sandbar_installations?: readonly InventoryInstallation[];
  readonly sandbar_db_volume?: string;
};

function installationsFrom(source: string): readonly InventoryInstallation[] {
  const document = parse(source) as unknown as GroupVars;
  const installations = document.sandbar_installations;
  if (!Array.isArray(installations)) {
    throw new Error("group_vars/all.yml lacks sandbar_installations");
  }
  return installations;
}

function render(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`unrendered placeholder ${name}`);
    return value;
  });
}

function renderPerInstallation(
  template: string,
  rows: readonly InventoryInstallation[],
  vars: Readonly<Record<string, string>>,
): string {
  const expanded = template.replace(INSTALLATION_LOOP, (_match, body: string) =>
    rows.map((row) => render(body, {
      "installation.user": row.user,
      "installation.project": row.project,
      "installation.clone_url": row.clone_url,
      "installation.reader_port": String(row.reader_port),
    })).join(""));
  return render(expanded, vars);
}

function directives(unit: string): string[] {
  return unit.split("\n").map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function values(unit: string, key: string): string[] {
  return directives(unit).filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

function taskNamed(source: string, name: string): string {
  const lines = source.split("\n");
  const marker = `- name: ${name}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start === -1) throw new Error(`missing task ${JSON.stringify(name)}`);
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  const relativeEnd = lines.slice(start + 1).findIndex(
    (line) => line.startsWith(`${" ".repeat(indent)}- name: `),
  );
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

const VPN_ADDRESS = "10.8.0.1";
// The box has no DNS name, so what a profile dials is a fact about the host.
const VPN_TEST_ENDPOINT = "203.0.113.5";
const SIMPLE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

// Renders are fed from the role's own defaults rather than repeated literals,
// so a default the design couples to another one cannot move alone. One level
// of indirection is resolved: the address Caddy binds is DECLARED as the
// tunnel address rather than spelled a second time.
function roleDefault(name: string): string {
  const raw = roleDefaults[name];
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(`role default ${name} is missing or not a scalar`);
  }
  const reference = String(raw).match(SIMPLE_PLACEHOLDER)?.[1];
  return reference === undefined ? String(raw) : roleDefault(reference);
}

function ipv4ToInt(text: string): number {
  const parts = text.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`not an IPv4 address: ${text}`);
  }
  return parts.reduce((total, part) => total * 256 + part, 0);
}

function renderVpnServer(dir: string = roleDefault("sandbar_vpn_dir")): string {
  return render(vpnServerTemplate, {
    sandbar_vpn_dir: dir,
    sandbar_vpn_network: roleDefault("sandbar_vpn_network"),
    sandbar_vpn_netmask: roleDefault("sandbar_vpn_netmask"),
    sandbar_vpn_address: roleDefault("sandbar_vpn_address"),
    sandbar_vpn_port: roleDefault("sandbar_vpn_port"),
    sandbar_vpn_proto: roleDefault("sandbar_vpn_proto"),
  });
}

// Stubs stand in for easy-rsa, openssl, openvpn and install: each records its
// argv and leaves behind the file the real tool would have left, which is all
// sandbar-vpn reads back.
const EASYRSA_STUB = `action=$1
case $action in --*) shift; action=$1 ;; esac
mkdir -p "$EASYRSA_PKI/issued" "$EASYRSA_PKI/private"
case $action in
\tinit-pki) : ;;
\tbuild-ca) echo CA-CERT >"$EASYRSA_PKI/ca.crt" ;;
\tbuild-server-full | build-client-full)
\t\techo "CERT-$2" >"$EASYRSA_PKI/issued/$2.crt"
\t\techo "KEY-$2" >"$EASYRSA_PKI/private/$2.key"
\t\t;;
\tgen-crl) echo CRL >"$EASYRSA_PKI/crl.pem" ;;
\trevoke) rm -f "$EASYRSA_PKI/issued/$2.crt" ;;
\t*) echo "stub easyrsa: unknown action $action" >&2; exit 3 ;;
esac`;
const INSTALL_STUB = `prev=""
last=""
for arg in "$@"; do prev=$last; last=$arg; done
cp "$prev" "$last"`;

type VpnBox = {
  readonly script: string;
  readonly vpnDir: string;
  readonly pki: string;
  readonly bin: string;
  readonly easyrsa: string;
  readonly log: string;
};

const vpnBoxes: string[] = [];
const pullBoxes: string[] = [];
const dumpBoxes: string[] = [];

type PullStatus = {
  readonly converged: string;
  readonly attempted: string;
  readonly result: string;
  readonly at: string;
};

type PullBox = {
  readonly script: string;
  readonly state: string;
  readonly status: string;
  readonly log: string;
  readonly remote: string;
  readonly lsExit: string;
  readonly ansibleExit: string;
  readonly checkoutHead: string;
  // One file per installation user holding its consumer's `main` tip; a
  // missing file is a lookup that fails.
  readonly consumers: string;
};

function writeStub(path: string, body: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\nset -eu\necho "$(basename "$0") $*" >>"$SANDBAR_VPN_STUB_LOG"\n${body}\n`,
    { mode: 0o755 },
  );
}

function vpnBox(): VpnBox {
  const root = mkdtempSync(join(tmpdir(), "sandbar-vpn-"));
  vpnBoxes.push(root);
  const box: VpnBox = {
    script: join(root, "sandbar-vpn"),
    vpnDir: join(root, "tunnel"),
    pki: join(root, "tunnel/pki"),
    bin: join(root, "bin"),
    easyrsa: join(root, "easy-rsa"),
    log: join(root, "stub.log"),
  };
  for (const dir of [box.vpnDir, box.bin, box.easyrsa]) mkdirSync(dir);
  writeFileSync(box.script, render(vpnScriptTemplate, {
    sandbar_vpn_dir: box.vpnDir,
    sandbar_vpn_endpoint: VPN_TEST_ENDPOINT,
    sandbar_vpn_port: roleDefault("sandbar_vpn_port"),
    sandbar_vpn_proto: roleDefault("sandbar_vpn_proto"),
  }));
  writeStub(join(box.bin, "id"), 'echo "${SANDBAR_VPN_STUB_UID:-0}"');
  writeStub(join(box.bin, "openssl"), 'cat "$3"');
  writeStub(join(box.bin, "openvpn"), 'echo TA-KEY >"$3"');
  writeStub(join(box.bin, "install"), INSTALL_STUB);
  writeStub(join(box.easyrsa, "easyrsa"), EASYRSA_STUB);
  return box;
}

function runVpn(box: VpnBox, argv: readonly string[], uid = "0") {
  return spawnSync("/bin/sh", [box.script, ...argv], {
    encoding: "utf8",
    env: {
      PATH: `${box.bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      EASYRSA: box.easyrsa,
      SANDBAR_VPN_STUB_LOG: box.log,
      SANDBAR_VPN_STUB_UID: uid,
    },
  });
}

function pullBox(): PullBox {
  const root = mkdtempSync(join(tmpdir(), "sandbar-pull-"));
  pullBoxes.push(root);
  const state = join(root, "state");
  const ui = join(root, "ui");
  const bin = join(root, "bin");
  const box: PullBox = {
    script: join(root, "sandbar-pull"),
    state,
    status: join(ui, DEPLOY_STATUS),
    log: join(root, "stub.log"),
    remote: join(root, "remote"),
    lsExit: join(root, "ls-exit"),
    ansibleExit: join(root, "ansible-exit"),
    checkoutHead: join(root, "checkout-head"),
    consumers: join(root, "consumers"),
  };
  for (const dir of [state, join(state, "deploy"), ui, bin, box.consumers]) mkdirSync(dir);
  for (const row of installations) writeFileSync(join(box.consumers, row.user), `${row.user}-tip\n`);
  writeFileSync(box.remote, "new-tip\n");
  writeFileSync(box.lsExit, "0\n");
  writeFileSync(box.ansibleExit, "0\n");
  writeFileSync(box.checkoutHead, "new-tip\n");
  writeFileSync(join(bin, "git"), `#!/bin/sh
set -eu
if [ -n "\${SANDBAR_PULL_STUB_AS:-}" ]; then
  echo "as $SANDBAR_PULL_STUB_AS: git $*" >>"$SANDBAR_PULL_STUB_LOG"
  [ "$1" = ls-remote ] || exit 90
  [ -r "$SANDBAR_PULL_CONSUMERS/$SANDBAR_PULL_STUB_AS" ] || exit 2
  printf '%s\\trefs/heads/main\\n' "$(cat "$SANDBAR_PULL_CONSUMERS/$SANDBAR_PULL_STUB_AS")"
  exit 0
fi
echo "git $*" >>"$SANDBAR_PULL_STUB_LOG"
if [ "$1" = ls-remote ]; then
  result=$(cat "$SANDBAR_PULL_LS_EXIT")
  [ "$result" -eq 0 ] || exit "$result"
  printf '%s\\trefs/heads/main\\n' "$(cat "$SANDBAR_PULL_REMOTE")"
elif [ "$1" = -C ]; then
  cat "$SANDBAR_PULL_CHECKOUT_HEAD"
else
  exit 90
fi
`, { mode: 0o755 });
  writeFileSync(join(bin, "ansible-pull"), `#!/bin/sh
set -eu
echo "ansible-pull $*" >>"$SANDBAR_PULL_STUB_LOG"
exit "$(cat "$SANDBAR_PULL_ANSIBLE_EXIT")"
`, { mode: 0o755 });
  // Runs the command as given, telling the git stub whose lookup it is.
  writeFileSync(join(bin, "runuser"), `#!/bin/sh
set -eu
[ "$1" = -u ] && [ "$3" = -- ] || exit 91
user=$2
shift 3
SANDBAR_PULL_STUB_AS=$user exec "$@"
`, { mode: 0o755 });
  const script = renderPerInstallation(pullScriptTemplate, installations, {
    sandbar_ui_root: ui,
    sandbar_deploy_status_file: DEPLOY_STATUS,
    sandbar_driver_repo: DRIVER_REPO,
    sandbar_driver_branch: DRIVER_BRANCH,
    sandbar_pull_dir: join(state, "deploy"),
  }).replaceAll("/usr/bin/git", join(bin, "git"))
    .replaceAll("/usr/bin/ansible-pull", join(bin, "ansible-pull"))
    .replaceAll("/usr/sbin/runuser", join(bin, "runuser"));
  writeFileSync(box.script, script, { mode: 0o755 });
  return box;
}

// What the script records for the stub consumers, one `<user> <tip>` line each.
function consumerTips(overrides: Readonly<Record<string, string>> = {}): string {
  return installations
    .map((row) => `${row.user} ${overrides[row.user] ?? `${row.user}-tip`}\n`)
    .join("");
}

function runPull(box: PullBox) {
  return spawnSync("/bin/sh", [box.script], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      SANDBAR_PULL_STUB_LOG: box.log,
      SANDBAR_PULL_REMOTE: box.remote,
      SANDBAR_PULL_LS_EXIT: box.lsExit,
      SANDBAR_PULL_ANSIBLE_EXIT: box.ansibleExit,
      SANDBAR_PULL_CHECKOUT_HEAD: box.checkoutHead,
      SANDBAR_PULL_CONSUMERS: box.consumers,
    },
  });
}

function pullStatus(box: PullBox): PullStatus {
  return JSON.parse(readFileSync(box.status, "utf8")) as PullStatus;
}

function pullInvocations(box: PullBox): readonly string[] {
  return readFileSync(box.log, "utf8").trim().split("\n");
}

async function renderedDeployText(status: PullStatus): Promise<string> {
  const page = renderPerInstallation(indexTemplate, installations, {
    sandbar_deploy_status_file: DEPLOY_STATUS,
  });
  const script = page.match(/<script>\n([\s\S]*?)<\/script>/)?.[1];
  if (script === undefined) throw new Error("rendered index lacks its script");
  const element = { textContent: "" };
  const fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => status,
  });
  const document = {
    getElementById(id: string) {
      if (id !== "deploy") throw new Error(`unexpected element id ${id}`);
      return element;
    },
  };
  Function("fetch", "document", script)(fetch, document);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return element.textContent;
}

afterAll(() => {
  for (const root of vpnBoxes) rmSync(root, { recursive: true, force: true });
  for (const root of pullBoxes) rmSync(root, { recursive: true, force: true });
  for (const root of dumpBoxes) rmSync(root, { recursive: true, force: true });
});

const installations = installationsFrom(groupVarsSource);
const installationConfigs = new Map([
  ["outdoor", outdoorConfig],
  ["outdoorpub", outdoorpubConfig],
  ["sandbar", sandbarConfig],
]);

function requiredVersion(config: string) {
  const text = config.match(/^\s*requiresSandbar:\s*"([^"]+)",$/m)?.[1];
  const version = text === undefined ? null : parseVersion(text);
  if (version === null) throw new Error("installation config lacks valid requiresSandbar");
  return version;
}

function varsFor(row: InventoryInstallation): Record<string, string> {
  const home = `/home/${row.user}`;
  return {
    sandbar_project: row.project,
    sandbar_checkout: `${home}/${row.project}`,
    sandbar_installation_dir: `${home}/installation`,
    sandbar_driver_current: DRIVER_CURRENT,
    sandbar_restart_exit_status: String(EXIT_CODE_RESTART),
    sandbar_reader_port: String(row.reader_port),
    sandbar_stop_timeout_sec: "900",
  };
}

describe.each(installations)("$project installation units", (row) => {
  const vars = varsFor(row);

  it("renders the built driver and external config contract", () => {
    const unit = render(daemonTemplate, vars);
    expect(unit).not.toMatch(/\{\{|\}\}/);
    expect(unit).not.toContain("git pull");
    expect(unit).not.toContain("npm ci");
    expect(values(unit, "WorkingDirectory")).toEqual([`/home/${row.user}/${row.project}`]);
    expect(values(unit, "EnvironmentFile")).toEqual([`/home/${row.user}/installation/sandbar.env`]);
    // No pre-start action at all: the driver is built by the play, not by a
    // daemon start (#146).
    expect(values(unit, "ExecStartPre")).toEqual([]);
    expect(values(unit, "ExecStart")).toEqual([
      `/usr/bin/node ${DRIVER_CURRENT}/dist/cli.js --config /home/${row.user}/installation/sandbar.config.mjs`,
    ]);
    expect(values(unit, "Restart")).toEqual(["no"]);
    expect(values(unit, "RestartForceExitStatus")).toEqual([String(EXIT_CODE_RESTART)]);
    expect(values(unit, "Requires")).toEqual(["podman.socket"]);
    expect(values(unit, "After")).toEqual(["podman.socket"]);
    expect(values(unit, "KillMode")).toEqual(["control-group"]);
    expect(values(unit, "ExitType")).toEqual(["cgroup"]);
    expect(values(unit, "TimeoutStopSec")).toEqual(["900"]);
    expect(values(unit, "WantedBy")).toEqual(["default.target"]);
  });

  it("renders the same driver's reader, restartable without its daemon", () => {
    const unit = render(uiTemplate, vars);
    expect(unit).not.toMatch(/\{\{|\}\}/);
    // No Requires=: restarting the reader onto a new build must not pull a
    // deliberately stopped daemon back up (#146).
    expect(values(unit, "Requires")).toEqual([]);
    expect(values(unit, "PartOf")).toEqual(["sandbar.service"]);
    expect(values(unit, "After")).toEqual(["sandbar.service"]);
    expect(values(unit, "ExecStartPre")).toEqual([]);
    expect(values(unit, "ExecStart")).toEqual([
      `/usr/bin/node ${DRIVER_CURRENT}/dist/cli.js ui --config /home/${row.user}/installation/sandbar.config.mjs --port ${row.reader_port}`,
    ]);
    expect(values(unit, "Restart")).toEqual(["no"]);
    expect(values(unit, "RestartForceExitStatus")).toEqual([]);
  });
});

describe("continuous deployment (#146)", () => {
  // The three spellings of one contract: the play writes the file and the
  // daemon reads it; the daemon exits the code and the unit starts it again.
  it("spells the restart contract the same way in the role and in src", () => {
    const defaults = roleDefaults;
    expect(defaults["sandbar_restart_request_file"]).toBe(RESTART_REQUEST_FILE);
    expect(defaults["sandbar_restart_exit_status"]).toBe(EXIT_CODE_RESTART);
    expect(defaults["sandbar_driver_root"]).toBe("/opt/sandbar");
    expect(defaults["sandbar_driver_current"]).toBe("{{ sandbar_driver_root }}/current");
    expect(defaults["sandbar_driver_branch"]).toBe(DRIVER_BRANCH);
    expect(defaults["sandbar_driver_repo"]).toBe(DRIVER_REPO);
    expect(defaults["sandbar_pull_dir"]).toBe(PULL_DIR);
    expect(defaults["sandbar_pull_interval"]).toBe(PULL_INTERVAL);
    expect(defaults["sandbar_ui_root"]).toBe(UI_ROOT);
    expect(defaults["sandbar_deploy_status_file"]).toBe(DEPLOY_STATUS);
    // Nothing pins a driver version any more: config and driver come from one
    // commit, so there is no tag left to lag or to satisfy.
    expect(roleDefaultsSource).not.toContain("driver_tag");
    expect(groupVarsSource).not.toContain("driver_tag");
    expect(mainTasks).not.toContain("driver_tag");
  });

  it("builds one directory per commit and flips `current` only after it built", () => {
    const gate = taskNamed(driverTasks, "Look for a completed build of that commit");
    expect(gate).toContain('path: "{{ sandbar_driver_build }}/{{ sandbar_driver_stamp }}"');
    const build = taskNamed(driverTasks, "Build the driver for that commit");
    expect(build).toContain("when: not sandbar_driver_built.stat.exists");
    expect(build).toContain("cmd: npm ci --no-audit --no-fund");
    expect(build).toContain("cmd: npm run build");
    expect(build).toContain("that: sandbar_driver_cli.stat.exists");
    // The stamp is the last thing the block writes, so an interrupted build is
    // rebuilt rather than adopted.
    expect(build.indexOf("npm run build"))
      .toBeLessThan(build.indexOf("- name: Mark the build complete"));
    const flip = taskNamed(driverTasks, "Point the current driver at that build");
    expect(flip).toContain('src: "{{ sandbar_driver_build }}"');
    expect(flip).toContain('dest: "{{ sandbar_driver_current }}"');
    expect(flip).toContain("state: link");
    expect(flip).toContain("register: sandbar_driver_flip");
    expect(driverTasks.indexOf("- name: Build the driver for that commit"))
      .toBeLessThan(driverTasks.indexOf("- name: Point the current driver at that build"));
  });

  it("keeps the current and previous builds and removes the rest", () => {
    const prune = taskNamed(driverTasks, "Remove every build but the current and the previous one");
    expect(prune).toContain("state: absent");
    expect(prune).toContain("reject('in', sandbar_driver_kept)");
    expect(prune).toContain('- "{{ sandbar_driver_build }}"');
    expect(prune).toContain('- "{{ sandbar_driver_link.stat.lnk_target | default(\'\') }}"');
    // Read before the flip, or "previous" would be the build just made.
    expect(driverTasks.indexOf("- name: Read the build the box is currently running"))
      .toBeLessThan(driverTasks.indexOf("- name: Point the current driver at that build"));
  });

  it("asks only the installations this play changed to restart", () => {
    const request = taskNamed(installationTasks, "Ask the daemon to restart into what this play changed");
    expect(request).toContain('content: "{{ sandbar_driver_commit }}\\n{{ \'urgent\\n\' if sandbar_restart_urgent | bool else \'\' }}"');
    expect(request).toContain(
      'dest: "{{ sandbar_installation_dir }}/{{ sandbar_restart_request_file }}"',
    );
    expect(request).toContain('owner: "{{ sandbar_user }}"');
    for (const trigger of [
      "sandbar_driver_flip is changed",
      "sandbar_installation_files_changed[sandbar_user] | default(false)",
      "sandbar_daemon_unit is changed",
      "sandbar_ui_unit is changed",
      "sandbar_config_digest_drift is changed",
    ]) {
      expect(request).toContain(trigger);
    }
    // The play never starts or restarts a daemon itself.
    expect(installationTasks).not.toContain("state: restarted");
    expect(installationTasks).not.toContain("state: started");
  });

  // The daemon defers an ordinary request; `Sandbar-Restart: now` on any
  // commit the flip applied drains it at once, and a pending urgent request
  // survives the next commit's ordinary one.
  it("marks a restart request urgent from a trailer in the flipped range", () => {
    const trailers = taskNamed(driverTasks, "Look for an urgent restart trailer in the commits this flip applied");
    expect(trailers).toContain('- "--format=%(trailers:key=Sandbar-Restart,valueonly)"');
    expect(trailers).toContain(
      '- "{{ sandbar_driver_link.stat.lnk_target | basename }}..{{ sandbar_driver_commit }}"',
    );
    expect(trailers).toContain("- sandbar_driver_flip is changed");
    expect(trailers).toContain("failed_when: false");
    const decide = taskNamed(driverTasks, "Decide whether this flip's restart requests are urgent");
    expect(decide).toContain("select('equalto', 'now')");
    expect(driverTasks.indexOf("- name: Point the current driver at that build"))
      .toBeLessThan(driverTasks.indexOf("- name: Look for an urgent restart trailer"));

    const pending = taskNamed(installationTasks, "Read the restart request still pending for this installation");
    expect(pending).toContain("ansible.builtin.slurp:");
    expect(pending).toContain("failed_when: false");
    const request = taskNamed(installationTasks, "Ask the daemon to restart into what this play changed");
    expect(request).toContain("sandbar_driver_urgent | default(false) | bool");
    expect(request).toContain("'urgent' in ((sandbar_pending_restart.content");
    expect(installationTasks.indexOf("- name: Read the restart request still pending"))
      .toBeLessThan(installationTasks.indexOf("- name: Ask the daemon to restart"));
  });

  // A consumer's gate stack or image change is a restart of its own (#190):
  // the daemon fixed both at import, and its sandboxes build the new ones.
  it("asks for a restart when the config digest moved, and records it only afterwards", () => {
    expect(roleDefaults["sandbar_config_digest_file"]).toBe("config-digest");
    const digest = taskNamed(
      installationTasks,
      "Digest the gate stack and images this installation's config evaluates to",
    );
    expect(digest).toContain('- "{{ sandbar_driver_current }}/dist/cli.js"');
    expect(digest).toContain("- config-digest");
    expect(digest).toContain('- "{{ sandbar_installation_dir }}/sandbar.config.mjs"');
    expect(digest).toContain('become_user: "{{ sandbar_user }}"');
    expect(digest).toContain("register: sandbar_config_digest");
    expect(digest).toContain("changed_when: false");
    const compare = taskNamed(
      installationTasks,
      "Compare that digest with the one recorded at the last restart request",
    );
    const record = taskNamed(
      installationTasks,
      "Record the config digest the daemon was asked to restart into",
    );
    for (const task of [compare, record]) {
      expect(task).toContain('content: "{{ sandbar_config_digest.stdout }}\\n"');
      expect(task).toContain(
        'dest: "{{ sandbar_installation_dir }}/{{ sandbar_config_digest_file }}"',
      );
      expect(task).toContain('owner: "{{ sandbar_user }}"');
      expect(task).toContain('mode: "0600"');
    }
    // The comparison writes nothing; a missing file is a would-be change.
    expect(compare).toContain("check_mode: true");
    expect(compare).toContain("register: sandbar_config_digest_drift");
    expect(record).not.toContain("check_mode");
    const order = [
      "- name: Clone the consumer repository",
      "- name: Pull the gate images podman lacks",
      "- name: Digest the gate stack and images",
      "- name: Compare that digest with the one recorded",
      "- name: Ask the daemon to restart into what this play changed",
      "- name: Record the config digest the daemon was asked to restart into",
    ].map((marker) => installationTasks.indexOf(marker));
    expect(order).not.toContain(-1);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("restarts only the reader, and only when its code or unit moved", () => {
    const uiTasks = readFileSync(new URL("tasks/ui.yml", ROLE), "utf8");
    const restart = taskNamed(uiTasks, "Restart the reader onto the current driver");
    expect(restart).toContain("name: sandbar-ui.service");
    expect(restart).toContain("state: restarted");
    expect(restart).toContain(
      "when: sandbar_driver_flip is changed or sandbar_ui_unit is changed",
    );
    const daemonTasks = readFileSync(new URL("tasks/service.yml", ROLE), "utf8");
    expect(daemonTasks).not.toContain("state: restarted");
    expect(daemonTasks).not.toContain("state: started");
  });

  it("keys the file-changed answer per installation across the two loops", () => {
    expect(taskNamed(prepareTasks, "Copy the installation configuration supplied by inventory"))
      .toContain("register: sandbar_installation_copy");
    const remember = taskNamed(prepareTasks, "Remember whether this installation's files changed");
    expect(remember).toContain("combine({sandbar_user: sandbar_installation_copy is changed})");
  });

  it("retries failed plays until the remote tip is recorded as converged", () => {
    const script = renderPerInstallation(pullScriptTemplate, installations, {
      sandbar_ui_root: UI_ROOT,
      sandbar_deploy_status_file: DEPLOY_STATUS,
      sandbar_driver_repo: DRIVER_REPO,
      sandbar_driver_branch: DRIVER_BRANCH,
      sandbar_pull_dir: PULL_DIR,
    });
    expect(script).not.toMatch(/\{\{|\}\}|\{%|%\}/);
    expect(script).not.toContain("--only-if-changed");
    expect(script).toContain("/usr/bin/git ls-remote --exit-code");
    expect(script).toContain(`refs/heads/${DRIVER_BRANCH}`);
    expect(script).toContain("converged_file=$state_dir/converged");
    expect(script).toContain("last_attempt_file=$state_dir/last-attempt");
    expect(script).toContain('if [ "$remote_tip" = "$converged" ] && consumers_converged; then');
    expect(script).toContain(`--url ${DRIVER_REPO}`);
    expect(script).toContain(`--checkout ${DRIVER_BRANCH}`);
    expect(script).toContain(`pull_dir=${PULL_DIR}`);
    expect(script).toContain('--directory "$pull_dir"');
    expect(script).toContain("--inventory localhost,");
    expect(script).toContain("deploy/ansible/site.yml");
    // A successful real attempt is persisted before its convergence marker;
    // failures persist the attempt without reaching the marker write.
    expect(script).toMatch(
      /if \[ "\$result" -eq 0 \] && \[ "\$head_result" -eq 0 \]; then\n  outcome=ok\n  record_attempt[^\n]*\n  printf[^]*?mv "\$converged_file\.new" "\$converged_file"/,
    );
    expect(script).toContain('outcome="failed (exit $result)"\n  record_attempt');
    expect(script).toContain('outcome="failed (ls-remote)"');
    // Every tick publishes all four fields atomically. A skip reaches this
    // without changing last-attempt, so it cannot turn a failure into ok.
    expect(script).toContain(`status=${UI_ROOT}/${DEPLOY_STATUS}`);
    expect(script).toContain(
      '{"converged":"$converged","attempted":"$attempted","result":"$outcome","at":',
    );
    expect(script).toContain('mv "$status.new" "$status"');
    expect(script).toContain('exit "$result"');
  });

  it("executes a missing-marker attempt, retries its failure, then skips after success", () => {
    const box = pullBox();
    writeFileSync(box.ansibleExit, "17\n");

    const failed = runPull(box);
    expect(failed.status).toBe(17);
    expect(existsSync(join(box.state, "converged"))).toBe(false);
    expect(readFileSync(join(box.state, "last-attempt"), "utf8"))
      .toBe("new-tip\nfailed (exit 17)\n");
    expect(pullStatus(box)).toEqual({
      converged: "unknown",
      attempted: "new-tip",
      result: "failed (exit 17)",
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });

    writeFileSync(box.ansibleExit, "0\n");
    const retried = runPull(box);
    expect(retried.status).toBe(0);
    expect(readFileSync(join(box.state, "converged"), "utf8")).toBe("new-tip\n");
    expect(pullStatus(box)).toEqual({
      converged: "new-tip",
      attempted: "new-tip",
      result: "ok",
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });

    const skipped = runPull(box);
    expect(skipped.status).toBe(0);
    const invocations = pullInvocations(box);
    expect(invocations.filter((line) => line.startsWith("git ls-remote"))).toHaveLength(3);
    expect(invocations.filter((line) => line.startsWith("ansible-pull "))).toHaveLength(2);
    expect(invocations.filter((line) => line.startsWith("git -C"))).toHaveLength(2);
    expect(pullStatus(box)).toEqual({
      converged: "new-tip",
      attempted: "new-tip",
      result: "ok",
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });
  });

  it("records an unreachable remote without moving the converged marker", () => {
    const box = pullBox();
    writeFileSync(join(box.state, "converged"), "old-tip\n");
    writeFileSync(box.lsExit, "23\n");

    const result = runPull(box);

    expect(result.status).toBe(23);
    expect(readFileSync(join(box.state, "converged"), "utf8")).toBe("old-tip\n");
    expect(pullInvocations(box).filter((line) => line.startsWith("ansible-pull ")))
      .toHaveLength(0);
    expect(readFileSync(join(box.state, "last-attempt"), "utf8"))
      .toBe("unknown\nfailed (ls-remote)\n");
    expect(pullStatus(box)).toEqual({
      converged: "old-tip",
      attempted: "unknown",
      result: "failed (ls-remote)",
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });
  });

  it("preserves a saved failure when an already-converged tick skips", () => {
    const box = pullBox();
    writeFileSync(join(box.state, "converged"), "new-tip\n");
    writeFileSync(join(box.state, "consumer-tips"), consumerTips());
    writeFileSync(join(box.state, "last-attempt"), "failed-tip\nfailed (exit 9)\n");
    writeFileSync(box.status, JSON.stringify({
      converged: "stale",
      attempted: "stale",
      result: "ok",
      at: "2000-01-01T00:00:00Z",
    }));

    const result = runPull(box);

    expect(result.status).toBe(0);
    expect(pullInvocations(box).filter((line) => line.startsWith("ansible-pull ")))
      .toHaveLength(0);
    expect(readFileSync(join(box.state, "last-attempt"), "utf8"))
      .toBe("failed-tip\nfailed (exit 9)\n");
    expect(pullStatus(box)).toEqual({
      converged: "new-tip",
      attempted: "failed-tip",
      result: "failed (exit 9)",
      at: expect.not.stringMatching(/^2000-/),
    });
  });

  // A consumer-only landing has to reach the play too, or a daemon keeps a gate
  // stack its sandboxes no longer agree with (#190).
  it("looks up every consumer's main as its installation's user", () => {
    const script = renderPerInstallation(pullScriptTemplate, installations, {
      sandbar_ui_root: UI_ROOT,
      sandbar_deploy_status_file: DEPLOY_STATUS,
      sandbar_driver_repo: DRIVER_REPO,
      sandbar_driver_branch: DRIVER_BRANCH,
      sandbar_pull_dir: PULL_DIR,
    });
    expect(script).toContain("consumer_tips_file=$state_dir/consumer-tips");
    expect(script).toContain(
      '/usr/sbin/runuser -u "$1" -- /usr/bin/env GIT_TERMINAL_PROMPT=0',
    );
    expect(script).toContain('/usr/bin/git ls-remote --exit-code "$2" refs/heads/main');
    for (const row of installations) {
      expect(script).toContain(`  consumer_tip ${row.user} ${row.clone_url}\n`);
    }
  });

  it("runs the play when only a consumer moved, recording the tips only after success", () => {
    const box = pullBox();
    writeFileSync(join(box.state, "converged"), "new-tip\n");

    // No record yet, as on the first tick after this landed: one play.
    expect(runPull(box).status).toBe(0);
    expect(readFileSync(join(box.state, "consumer-tips"), "utf8")).toBe(consumerTips());
    expect(pullInvocations(box).filter((line) => line.startsWith("ansible-pull ")))
      .toHaveLength(1);
    for (const row of installations) {
      expect(pullInvocations(box)).toContain(
        `as ${row.user}: git ls-remote --exit-code ${row.clone_url} refs/heads/main`,
      );
    }

    expect(runPull(box).status).toBe(0);
    expect(pullInvocations(box).filter((line) => line.startsWith("ansible-pull ")))
      .toHaveLength(1);

    const moved = installations[0]!.user;
    writeFileSync(join(box.consumers, moved), "moved-tip\n");
    writeFileSync(box.ansibleExit, "5\n");
    expect(runPull(box).status).toBe(5);
    expect(readFileSync(join(box.state, "consumer-tips"), "utf8")).toBe(consumerTips());
    expect(readFileSync(join(box.state, "converged"), "utf8")).toBe("new-tip\n");

    writeFileSync(box.ansibleExit, "0\n");
    expect(runPull(box).status).toBe(0);
    expect(readFileSync(join(box.state, "consumer-tips"), "utf8"))
      .toBe(consumerTips({ [moved]: "moved-tip" }));
    expect(runPull(box).status).toBe(0);
    expect(pullInvocations(box).filter((line) => line.startsWith("ansible-pull ")))
      .toHaveLength(3);
  });

  it("never counts a consumer it cannot look up as converged", () => {
    const box = pullBox();
    const lost = installations[0]!.user;
    rmSync(join(box.consumers, lost));
    writeFileSync(join(box.state, "converged"), "new-tip\n");
    // Even a record that saw the same failure does not skip the play.
    writeFileSync(join(box.state, "consumer-tips"), consumerTips({ [lost]: "unknown" }));

    expect(runPull(box).status).toBe(0);

    expect(pullInvocations(box).filter((line) => line.startsWith("ansible-pull ")))
      .toHaveLength(1);
  });

  it("activates that script from a timer and never from the unit itself", () => {
    const service = render(pullServiceTemplate, {
      sandbar_driver_repo: DRIVER_REPO,
      sandbar_driver_branch: DRIVER_BRANCH,
    });
    expect(values(service, "Type")).toEqual(["oneshot"]);
    expect(values(service, "ExecStart")).toEqual(["/usr/local/bin/sandbar-pull"]);
    expect(values(service, "WantedBy")).toEqual([]);
    const timer = render(pullTimerTemplate, {
      sandbar_pull_interval: PULL_INTERVAL,
      sandbar_driver_branch: DRIVER_BRANCH,
    });
    expect(values(timer, "OnBootSec")).toEqual([PULL_INTERVAL]);
    expect(values(timer, "OnUnitInactiveSec")).toEqual([PULL_INTERVAL]);
    expect(values(timer, "Persistent")).toEqual(["true"]);
    expect(values(timer, "WantedBy")).toEqual(["timers.target"]);
    const enable = taskNamed(pullTasks, "Enable and start the convergence timer");
    expect(enable).toContain("name: sandbar-pull.timer");
    expect(enable).toContain("enabled: true");
    expect(enable).toContain("state: started");
    expect(taskNamed(pullTasks, "Install Ansible on the box so it can converge itself"))
      .toContain("name: ansible");
  });

  it("builds the driver before the unit pass and installs the timer last", () => {
    const driver = taskNamed(mainTasks, "Build the driver every installation runs");
    expect(driver).toContain("ansible.builtin.import_tasks: driver.yml");
    expect(driver).not.toContain("loop:");
    const pull = taskNamed(mainTasks, "Install the convergence timer that applies every later commit");
    expect(pull).toContain("ansible.builtin.import_tasks: pull.yml");
    expect(pull).not.toContain("loop:");
    expect(mainTasks.indexOf("Build the driver every installation runs"))
      .toBeLessThan(mainTasks.indexOf("Configure each sandbar checkout and unit pair"));
    expect(mainTasks.indexOf("Install the convergence timer that applies every later commit"))
      .toBeGreaterThan(mainTasks.indexOf("Configure each sandbar checkout and unit pair"));
  });

  it("falls back to the operator keys the box remembers", () => {
    const supplied = taskNamed(mainTasks, "Separate the operator keys this invocation supplied from empty placeholders");
    expect(supplied).toContain("reject('equalto', '')");
    const read = taskNamed(mainTasks, "Read the operator keys the box remembers");
    expect(read).toContain("sandbar_supplied_ssh_keys | length == 0");
    expect(read).toContain("sandbar_remembered_keys_file.stat.exists");
    const take = taskNamed(mainTasks, "Take the operator keys from this invocation, or from the box's memory");
    expect(take).toContain("sandbar_supplied_ssh_keys if sandbar_supplied_ssh_keys | length > 0");
    const remember = taskNamed(mainTasks, "Remember the operator keys so the box can converge unattended");
    expect(remember).toContain('dest: "{{ sandbar_operator_keys_file }}"');
    // An empty list must refuse rather than strip every key off root.
    const refusal = taskNamed(mainTasks, "Refuse to run without the host variables the role cannot default");
    expect(refusal).toContain("sandbar_operator_ssh_keys | length > 0");
    expect(mainTasks.indexOf("Take the operator keys from this invocation"))
      .toBeLessThan(mainTasks.indexOf("Refuse to run without the host variables"));
    expect(mainTasks.indexOf("Refuse to run without the host variables"))
      .toBeLessThan(mainTasks.indexOf("Remember the operator keys so the box"));
  });
});

describe("multi-installation role orchestration", () => {
  it("loops each user-scoped phase over the installation list", () => {
    for (const [name, include] of [
      ["Create each installation account and podman session", "account.yml"],
      ["Prepare each installation directory", "prepare-installation.yml"],
      ["Configure each sandbar checkout and unit pair", "installation.yml"],
    ] as const) {
      const task = taskNamed(mainTasks, name);
      expect(task).toContain(`ansible.builtin.include_tasks: ${include}`);
      expect(task).toContain('loop: "{{ sandbar_installations }}"');
      expect(task).toContain("loop_var: sandbar_installation");
    }
  });

  it("keeps host-global actions outside those loops", () => {
    for (const [name, include] of [
      ["Install host packages", "packages.yml"],
      ["Configure host podman prerequisites", "podman-global.yml"],
      ["Reconcile the AppArmor profiles rootless podman runs under", "apparmor.yml"],
      ["Provide swap", "swap.yml"],
      ["Restrict SSH", "ssh.yml"],
      ["Configure unattended upgrades", "upgrades.yml"],
      ["Configure Caddy installation routes", "caddy.yml"],
    ] as const) {
      const task = taskNamed(mainTasks, name);
      expect(task).toContain(`ansible.builtin.import_tasks: ${include}`);
      expect(task).not.toContain("loop:");
    }
  });

  it("includes user, podman, daemon and UI actions in the looped phases", () => {
    expect(taskNamed(accountTasks, "Create the installation user"))
      .toContain("ansible.builtin.include_tasks: user.yml");
    expect(taskNamed(accountTasks, "Configure rootless podman for the installation user"))
      .toContain("ansible.builtin.include_tasks: podman.yml");
    expect(taskNamed(installationTasks, "Install the daemon unit"))
      .toContain("ansible.builtin.include_tasks: service.yml");
    expect(taskNamed(installationTasks, "Install the standalone UI unit"))
      .toContain("ansible.builtin.include_tasks: ui.yml");
  });

  it("copies the optional installation config and nothing else into the directory", () => {
    expect(taskNamed(prepareTasks, "Copy the installation configuration supplied by inventory"))
      .toContain("when: sandbar_installation.config_src is defined");
    // The role-owned driver installer and its shared module are gone with the
    // exact-tag driver (#146).
    expect(prepareTasks).not.toContain("install-driver.mjs");
    expect(prepareTasks).not.toContain("driver-install.mjs");
  });

  it("asserts both required files exist and names the failed path", () => {
    const stat = taskNamed(installationTasks, "Check the required installation files");
    expect(stat).toContain("- sandbar.config.mjs\n    - sandbar.env");
    const refusal = taskNamed(installationTasks, "Stop unless every required installation file exists");
    expect(refusal).toContain("- item.stat.exists");
    expect(refusal).toContain("{{ sandbar_installation_dir }}/{{ item.item }}:");
  });

  it("clones each consumer and excludes the local work directory", () => {
    expect(taskNamed(installationTasks, "Clone the consumer repository"))
      .toContain('repo: "{{ sandbar_installation.clone_url }}"');
    const exclude = taskNamed(installationTasks, "Keep the work directory out of the consumer repository");
    expect(exclude).toContain('path: "{{ sandbar_checkout }}/.git/info/exclude"');
    expect(exclude).toContain('line: "/{{ sandbar_work_dir }}/"');
  });

  it("pulls the gate images the driver says the installation config does not build", () => {
    const list = taskNamed(installationTasks, "List the gate images this installation's config needs pulled");
    expect(list).toContain('- "{{ sandbar_driver_current }}/dist/cli.js"');
    expect(list).toContain("- pulled-images");
    expect(list).toContain('- "{{ sandbar_installation_dir }}/sandbar.config.mjs"');
    expect(list).toContain('become_user: "{{ sandbar_user }}"');
    const presence = taskNamed(installationTasks, "Ask podman which of those images it already has");
    expect(presence).toContain('loop: "{{ sandbar_pulled_images.stdout_lines }}"');
    expect(presence).toContain("failed_when: sandbar_pulled_image_presence.rc not in [0, 1]");
    const pull = taskNamed(installationTasks, "Pull the gate images podman lacks");
    expect(pull).toContain('argv: [podman, pull, "{{ item.item }}"]');
    expect(pull).toContain("selectattr('rc', 'equalto', 1)");
    expect(pull).toContain('become_user: "{{ sandbar_user }}"');
    // After the clone a config may read its gate stack from, and before the
    // restart request whose daemon would otherwise refuse at preflight.
    expect(installationTasks.indexOf("- name: Clone the consumer repository"))
      .toBeLessThan(installationTasks.indexOf("- name: List the gate images"));
    expect(installationTasks.indexOf("- name: Pull the gate images podman lacks"))
      .toBeLessThan(installationTasks.indexOf("- name: Ask the daemon to restart"));
  });

  it("validates isolation-critical installation fields before host tasks", () => {
    const host = taskNamed(mainTasks, "Refuse to run without the host variables the role cannot default");
    expect(host).toContain("sandbar_installations is sequence");
    expect(host).toContain("sandbar_installations is not string");
    expect(host).toContain("sandbar_installations is not mapping");
    const entry = taskNamed(mainTasks, "Validate every installation inventory entry");
    expect(entry).toContain("(item.user | default('')) is match('^[a-z_][a-z0-9_-]{0,31}$')");
    expect(entry).toContain("(item.user | default('')) != 'root'");
    expect(entry).toContain("(item.project | default('')) is match('^[A-Za-z0-9][A-Za-z0-9._-]*$')");
    expect(entry).toContain("(item.project | default('')) != 'installation'");
    expect(entry).toContain("(item.reader_port | default(none)) is integer");
    expect(entry).toContain("(item.reader_port | default(0) | int) >= 1");
    expect(entry).toContain("(item.reader_port | default(0) | int) <= 65535");
    expect(entry).toContain("(item.subid_slot | default(none)) is integer");
    expect(entry).toContain("(item.subid_slot | default(-1) | int) >= 0");
    const unique = taskNamed(
      mainTasks,
      "Refuse installation identities, routes, reader ports or subid slots that are not unique",
    );
    expect(unique).toContain("map(attribute='user')");
    expect(unique).toContain("map(attribute='project')");
    expect(unique).toContain("map(attribute='reader_port')");
    expect(unique).toContain("map(attribute='subid_slot')");
    expect(mainTasks.indexOf("Validate every installation inventory entry"))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
    expect(mainTasks.indexOf(
      "Refuse installation identities, routes, reader ports or subid slots that are not unique",
    ))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
  });

  it("derives the subordinate id range from the entry's slot, never the list index", () => {
    expect(mainTasks).toContain(
      'sandbar_subid_start: "{{ sandbar_subid_base + (sandbar_installation.subid_slot | int) * sandbar_subid_count }}"',
    );
    expect(mainTasks).not.toContain("sandbar_installation_index");
    const slots = installations.map((row) => row.subid_slot);
    expect(new Set(slots).size).toBe(slots.length);
    for (const slot of slots) {
      expect(Number.isInteger(slot) && slot >= 0).toBe(true);
    }
  });

  it("refuses to move a subordinate id range under existing podman storage", () => {
    const read = taskNamed(userTasks, "Read the installation user's recorded subordinate id ranges");
    expect(read).toContain('grep -h "^{{ sandbar_user }}:" /etc/subuid /etc/subgid');
    expect(read).toContain("changed_when: false");
    const storage = taskNamed(userTasks, "Check for the installation user's rootless podman storage");
    expect(storage).toContain('path: "{{ sandbar_home }}/.local/share/containers/storage"');
    const refusal = taskNamed(userTasks, "Refuse to move a subordinate id range under existing podman storage");
    expect(refusal).toContain("not sandbar_podman_storage.stat.exists");
    expect(refusal).toContain(
      "reject('equalto', sandbar_user ~ ':' ~ sandbar_subid_start ~ ':' ~ sandbar_subid_count)",
    );
    const write = "- name: Give the installation user disjoint subordinate id ranges";
    expect(userTasks.indexOf("Refuse to move a subordinate id range under existing podman storage"))
      .toBeLessThan(userTasks.indexOf(write));
    const migrate = taskNamed(
      userTasks,
      "Restart the installation user's rootless pause process after a range change",
    );
    expect(migrate).toContain("podman system migrate");
    expect(migrate).toContain("when: sandbar_subids is changed");
    expect(userTasks.indexOf(write)).toBeLessThan(userTasks.indexOf(
      "Restart the installation user's rootless pause process after a range change",
    ));
  });

  it("renders one stripped-prefix route per reader and serves the static index", () => {
    expect(renderPerInstallation(caddyTemplate, installations, {
      sandbar_ui_bind: roleDefault("sandbar_ui_bind"),
      sandbar_ui_http_port: "80",
      sandbar_ui_root: UI_ROOT,
      sandbar_ui_access_log: roleDefault("sandbar_ui_access_log"),
    })).toBe(`:80 {
\tbind ${VPN_ADDRESS}
\tlog {
\t\toutput file /var/log/caddy/sandbar-ui.log
\t}
\thandle_path /outdoor/* {
\t\treverse_proxy 127.0.0.1:7332
\t}
\thandle_path /outdoorpub/* {
\t\treverse_proxy 127.0.0.1:7336
\t}
\thandle_path /sandbar/* {
\t\treverse_proxy 127.0.0.1:7333
\t}
\troot * ${UI_ROOT}
\tfile_server
}
`);
    expect(caddyTemplate).not.toContain("<<");
    expect(taskNamed(caddyTasks, "Configure Caddy installation routes and index"))
      .toContain("notify: Reload Caddy");
    const startName = "Enable and start Caddy";
    const flushName = "Apply the Caddy configuration before installation checks can stop the play";
    const start = taskNamed(caddyTasks, startName);
    const flush = taskNamed(caddyTasks, flushName);
    expect(start).toContain("ansible.builtin.systemd_service:");
    expect(start).toContain("name: caddy");
    expect(start).toContain("enabled: true");
    expect(start).toContain("state: started");
    expect(flush).toContain("ansible.builtin.meta: flush_handlers");
    expect(caddyTasks.indexOf(`- name: ${startName}`))
      .toBeLessThan(caddyTasks.indexOf(`- name: ${flushName}`));
  });

  it("renders an ordered index that also reports the box's last convergence", () => {
    const page = renderPerInstallation(indexTemplate, installations, {
      sandbar_deploy_status_file: DEPLOY_STATUS,
    });
    expect(page).not.toMatch(/\{\{|\}\}/);
    expect(page).toContain('<li><a href="/outdoor/">outdoor</a></li>\n<li><a href="/outdoorpub/">outdoorpub</a></li>\n<li><a href="/sandbar/">sandbar</a></li>');
    expect(page.indexOf('href="/outdoor/"')).toBeLessThan(page.indexOf('href="/outdoorpub/"'));
    expect(page.indexOf('href="/outdoorpub/"')).toBeLessThan(page.indexOf('href="/sandbar/"'));
    expect(page).toContain(`fetch("${DEPLOY_STATUS}", { cache: "no-store" })`);
    expect(page).toContain('document.getElementById("deploy")');
    expect(page).toContain('status.result === "ok"');
    expect(page).toContain('`${status.attempted} ${status.result}`');
    expect(page).toContain('new Intl.DateTimeFormat("nl-BE"');
    expect(page).toContain('timeZone: "Europe/Brussels"');
    expect(page).toContain('`box on ${status.converged} · ${attempt} · checked ${brusselsTime.format(new Date(status.at))}`');
    expect(page).toContain("No convergence recorded yet");
    const renderTask = taskNamed(caddyTasks, "Render the installation index");
    expect(renderTask).toContain("src: index.html.j2");
    expect(renderTask).toContain('dest: "{{ sandbar_ui_root }}/index.html"');
    expect(caddyTasks.indexOf("- name: Render the installation index"))
      .toBeLessThan(caddyTasks.indexOf("- name: Configure Caddy installation routes and index"));
  });

  it.each([
    {
      name: "successful convergence",
      status: {
        converged: "abc123", attempted: "abc123", result: "ok", at: "2026-09-25T10:00:00Z",
      },
      text: "box on abc123 · ok · checked 25 sep, 12:00:00",
    },
    {
      name: "failed convergence",
      status: {
        converged: "old123", attempted: "new456", result: "failed (exit 7)",
        at: "2026-01-25T10:05:00Z",
      },
      text: "box on old123 · new456 failed (exit 7) · checked 25 jan, 11:05:00",
    },
    {
      name: "failed remote lookup",
      status: {
        converged: "old123", attempted: "unknown", result: "failed (ls-remote)",
        at: "2026-09-25T10:10:00Z",
      },
      text: "box on old123 · unknown failed (ls-remote) · checked 25 sep, 12:10:00",
    },
  ])("executes the index script for $name", async ({ status, text }) => {
    await expect(renderedDeployText(status)).resolves.toBe(text);
  });
});

describe("the operator VPN the run UI answers on (#155)", () => {
  it("binds the UI to the tunnel address and refuses a public one", () => {
    expect(roleDefaults["sandbar_vpn_address"]).toBe(VPN_ADDRESS);
    expect(roleDefaults["sandbar_ui_bind"]).toBe("{{ sandbar_vpn_address }}");
    expect(directives(caddyTemplate)[1]).toBe("bind {{ sandbar_ui_bind }}");
    const refusal = taskNamed(mainTasks, "Refuse a run UI that would answer on a public interface");
    expect(refusal).toContain("sandbar_ui_bind | length > 0");
    expect(refusal).toContain("sandbar_ui_bind not in ['0.0.0.0', '::', '*']");
    expect(refusal).toContain("sandbar_vpn_endpoint | length > 0");
    expect(refusal).toContain("sandbar_vpn_proto in ['tcp', 'udp']");
    expect(mainTasks.indexOf("Refuse a run UI that would answer on a public interface"))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
  });

  it("logs every request, successful ones included", () => {
    expect(roleDefaults["sandbar_ui_access_log"]).toBe("/var/log/caddy/sandbar-ui.log");
    const directory = taskNamed(caddyTasks, "Create the access log directory");
    expect(directory).toContain('path: "{{ sandbar_ui_access_log | dirname }}"');
    expect(directory).toContain("owner: caddy");
    expect(caddyTasks.indexOf("- name: Create the access log directory"))
      .toBeLessThan(caddyTasks.indexOf("- name: Configure Caddy installation routes and index"));
  });

  // The address Caddy binds is not independent of the subnet the server hands
  // out: `server <network> <netmask>` gives the tunnel interface the first
  // host of that network, so a network the bind address is not the first host
  // of leaves the UI answering on an address that never comes up.
  it("binds the address the server hands its own tunnel interface", () => {
    const network = ipv4ToInt(roleDefault("sandbar_vpn_network"));
    const netmask = ipv4ToInt(roleDefault("sandbar_vpn_netmask"));
    expect(ipv4ToInt(roleDefault("sandbar_vpn_address")))
      .toBe(((network & netmask) >>> 0) + 1);
    expect(directives(renderVpnServer())).toContain(
      `server ${roleDefault("sandbar_vpn_network")} ${roleDefault("sandbar_vpn_netmask")}`,
    );
  });

  it("grants a client the tunnel subnet and nothing else", () => {
    const server = renderVpnServer();
    expect(server).not.toMatch(/\{\{|\}\}/);
    for (const reach of ["push", "redirect-gateway", "client-to-client"]) {
      expect(directives(server).join("\n")).not.toContain(reach);
    }
    const forwarding = taskNamed(vpnTasks, "Forward nothing between this box's interfaces");
    expect(forwarding).toContain("name: net.ipv4.ip_forward");
    expect(forwarding).toContain('value: "0"');
  });

  // TCP on 443 is the one a hotel or guest network is least likely to block,
  // and it is what an issued profile dials: the same two variables render the
  // server and the script, so the pair cannot drift apart.
  it("speaks the transport an issued profile dials", () => {
    expect(roleDefaults["sandbar_vpn_proto"]).toBe("tcp");
    expect(roleDefaults["sandbar_vpn_port"]).toBe(443);
    expect(directives(renderVpnServer())).toContain("proto tcp-server");
    expect(directives(renderVpnServer())).toContain("port 443");
    expect(directives(renderVpnServer())).toContain("remote-cert-tls client");
  });

  // The box has no DNS name, so the address a profile dials is a fact about
  // the host rather than something an inventory has to carry. Without this
  // default the public-interface refusal above evaluates an undefined
  // variable on every box that does not override it.
  it("dials this box at the address it answers the world on", () => {
    expect(roleDefaults["sandbar_vpn_endpoint"])
      .toBe("{{ ansible_facts['default_ipv4']['address'] | default('') }}");
    expect(vpnScriptTemplate).toContain("VPN_ENDPOINT={{ sandbar_vpn_endpoint }}");
  });

  it("verifies every certificate against a revocation list the server can read", () => {
    const server = directives(renderVpnServer());
    expect(server).toContain(`crl-verify ${roleDefault("sandbar_vpn_dir")}/crl.pem`);
    expect(server).toContain("user nobody");
    // The list is published outside the root-only PKI the rest is read from.
    expect(vpnScriptTemplate).toContain('CRL="$VPN_DIR/crl.pem"');
    expect(vpnScriptTemplate).toContain("EASYRSA_CRL_DAYS=3650");
  });

  it("provides the server, its tools, and an address Caddy can bind before it", () => {
    const packages = taskNamed(vpnTasks, "Install OpenVPN and easy-rsa");
    expect(packages).toContain("- openvpn");
    expect(packages).toContain("- easy-rsa");
    const directory = taskNamed(vpnTasks, "Create the VPN directory");
    expect(directory).toContain('path: "{{ sandbar_vpn_dir }}"');
    expect(directory).toContain("state: directory");
    // Caddy binds the tunnel address, so it must be bindable before tun0.
    const nonlocal = taskNamed(vpnTasks, "Allow binding an address the tunnel has not brought up yet");
    expect(nonlocal).toContain("name: net.ipv4.ip_nonlocal_bind");
    expect(nonlocal).toContain('value: "1"');
  });

  it("initialises one certificate authority on the box and repeats no work", () => {
    const init = taskNamed(vpnTasks, "Initialise the certificate authority");
    expect(init).toContain("ansible.builtin.command: /usr/local/sbin/sandbar-vpn init");
    expect(init).toContain('creates: "{{ sandbar_vpn_dir }}/pki/issued/server.crt"');
    // Rendered rather than copied: the script and the server configuration
    // read this box's tunnel directory and dial-in facts from one place.
    const script = taskNamed(vpnTasks, "Install the certificate authority script");
    expect(script).toContain("ansible.builtin.template:");
    expect(script).toContain("src: sandbar-vpn.j2");
    expect(script).toContain("dest: /usr/local/sbin/sandbar-vpn");
    expect(script).toContain('mode: "0700"');
    expect(vpnTasks.indexOf("- name: Install the certificate authority script"))
      .toBeLessThan(vpnTasks.indexOf("- name: Initialise the certificate authority"));
  });

  it("keeps devices out of play state and out of the public deploy data", () => {
    const commands = vpnTasks.split("\n")
      .filter((line) => line.trimStart().startsWith("ansible.builtin.command:"));
    expect(commands).toEqual(["  ansible.builtin.command: /usr/local/sbin/sandbar-vpn init"]);
    for (const source of [inventorySource, groupVarsSource]) {
      expect(source).not.toContain("sandbar-vpn");
      expect(source).not.toContain(".ovpn");
    }
  });

  it("starts the server the rendered configuration names", () => {
    const configure = taskNamed(vpnTasks, "Configure the VPN server");
    expect(configure).toContain("dest: /etc/openvpn/server/sandbar.conf");
    expect(configure).toContain('mode: "0600"');
    expect(configure).toContain("notify: Restart OpenVPN");
    const start = taskNamed(vpnTasks, "Enable and start the VPN server");
    expect(start).toContain("name: openvpn-server@sandbar");
    expect(start).toContain("enabled: true");
    expect(start).toContain("state: started");
    expect(taskNamed(handlers, "Restart OpenVPN")).toContain("name: openvpn-server@sandbar");
    expect(taskNamed(mainTasks, "Provide the operator VPN the run UI answers on"))
      .toContain("ansible.builtin.import_tasks: vpn.yml");
    expect(mainTasks.indexOf("import_tasks: vpn.yml"))
      .toBeLessThan(mainTasks.indexOf("import_tasks: caddy.yml"));
  });
});

// The device lifecycle is a shell program the role renders and a human runs,
// so it is RUN here: against stub easy-rsa, openssl, openvpn and install on
// PATH, in a throwaway tunnel directory. What the stubs leave behind is what
// the real tools leave behind, which is what lets the server configuration's
// own paths be the assertion.
describe("sandbar-vpn, the device lifecycle (#155)", () => {
  it("is a shell program once the role has rendered it", () => {
    const box = vpnBox();
    expect(readFileSync(box.script, "utf8")).not.toMatch(/\{\{|\}\}/);
    const parsed = spawnSync("/bin/sh", ["-n", box.script], { encoding: "utf8" });
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
  });

  it("is root-only, and refuses a verb it does not implement", () => {
    const box = vpnBox();
    const asUser = runVpn(box, ["init"], "1000");
    expect(asUser.status).not.toBe(0);
    expect(asUser.stderr).toContain("run as root");
    expect(existsSync(box.pki)).toBe(false);
    for (const argv of [[], ["issue-profile", "tojins-laptop"]]) {
      const refused = runVpn(box, argv);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("usage: sandbar-vpn init | issue");
    }
  });

  it("creates exactly the files the server configuration reads, once", () => {
    const box = vpnBox();
    expect(runVpn(box, ["init"]).status).toBe(0);
    const named = directives(renderVpnServer(box.vpnDir))
      .filter((line) => /^(ca|cert|key|tls-crypt|crl-verify) /.test(line))
      .map((line) => line.split(" ")[1]);
    expect(named).toHaveLength(5);
    for (const path of named) expect(existsSync(path!)).toBe(true);
    // The server drops to `nobody`, so the list it re-reads is world-readable
    // and outside the PKI.
    expect(readFileSync(box.log, "utf8")).toContain(
      `install -m 0644 -o root -g root ${box.pki}/crl.pem ${box.vpnDir}/crl.pem`,
    );
    // A second CA would leave every profile already handed out unable to
    // connect, so `init` refuses rather than replacing one.
    const again = runVpn(box, ["init"]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("start a new CA");
  });

  it("issues a profile that is the whole of what a device needs", () => {
    const box = vpnBox();
    runVpn(box, ["init"]);
    const issued = runVpn(box, ["issue", "tojins-laptop"]);
    expect(issued.status).toBe(0);
    // The heredoc is the file verbatim: no indentation, nothing but profile.
    expect(issued.stdout).toMatch(/^client\ndev tun\n/);
    expect(issued.stdout).toContain("proto tcp-client");
    expect(issued.stdout).toContain(`remote ${VPN_TEST_ENDPOINT} 443`);
    expect(issued.stdout).toContain("remote-cert-tls server");
    expect(issued.stdout).toContain("<ca>\nCA-CERT\n</ca>");
    expect(issued.stdout).toContain("<cert>\nCERT-tojins-laptop\n</cert>");
    expect(issued.stdout).toContain("<key>\nKEY-tojins-laptop\n</key>");
    expect(issued.stdout).toContain("<tls-crypt>\nTA-KEY\n</tls-crypt>");
  });

  it("refuses a name that is not one device's, and a device that already has a profile", () => {
    const box = vpnBox();
    runVpn(box, ["init"]);
    for (const name of ["", "../../etc/shadow", "tojins laptop", "server"]) {
      const refused = runVpn(box, ["issue", name]);
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toBe("");
    }
    expect(runVpn(box, ["issue", "tojins-laptop"]).status).toBe(0);
    const twice = runVpn(box, ["issue", "tojins-laptop"]);
    expect(twice.status).not.toBe(0);
    expect(twice.stderr).toContain("already has a profile");
    expect(twice.stdout).toBe("");
  });

  // The same rule on the other verb, where it is the load-bearing one:
  // `init` leaves `issued/server.crt` behind, so an unguarded
  // `revoke server` clears the existence check and withdraws the
  // certificate every device authenticates the server by.
  it("refuses those names on revoke too, the server's own certificate included", () => {
    const box = vpnBox();
    runVpn(box, ["init"]);
    runVpn(box, ["issue", "tojins-laptop"]);
    for (const name of ["", "../../etc/shadow", "tojins laptop", "server"]) {
      const refused = runVpn(box, ["revoke", name]);
      expect(refused.status).not.toBe(0);
      // Refused by the name rule, not by happening to name nothing issued.
      expect(refused.stderr).not.toContain("no profile named");
    }
    expect(existsSync(join(box.pki, "issued/server.crt"))).toBe(true);
    expect(readFileSync(box.log, "utf8")).not.toContain("easyrsa revoke");
  });

  it("revokes one device, republishing the list and leaving the others alone", () => {
    const box = vpnBox();
    runVpn(box, ["init"]);
    runVpn(box, ["issue", "tojins-laptop"]);
    runVpn(box, ["issue", "coworker-desktop"]);
    const unknown = runVpn(box, ["revoke", "nobodys-laptop"]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("no profile named");

    writeFileSync(join(box.vpnDir, "crl.pem"), "STALE\n");
    const revoked = runVpn(box, ["revoke", "tojins-laptop"]);
    expect(revoked.status).toBe(0);
    expect(readFileSync(box.log, "utf8")).toContain("easyrsa revoke tojins-laptop");
    expect(readFileSync(join(box.vpnDir, "crl.pem"), "utf8")).toBe("CRL\n");
    expect(existsSync(join(box.pki, "issued/coworker-desktop.crt"))).toBe(true);
    expect(revoked.stderr).toContain("restart openvpn-server@sandbar");
  });
});

describe("committed installation data and configs", () => {
  it("keeps the installation list out of the inventory both channels cannot share", () => {
    // `ansible-pull` runs with `-i localhost,` and therefore has no
    // inventory_dir; group_vars beside site.yml is what both channels read.
    expect(inventorySource).not.toContain("sandbar_installations");
    for (const entry of installations) {
      expect(entry.config_src).toContain("{{ playbook_dir }}/installations/");
    }
  });

  it("validates every installation entry", () => {
    expect(installations).toHaveLength(3);
    const users = new Set<string>();
    const projects = new Set<string>();
    const ports = new Set<number>();
    for (const entry of installations) {
      expect(entry.user).toMatch(SAFE_USER);
      expect(entry.user).not.toBe("root");
      expect(entry.project).toMatch(SAFE_PROJECT);
      expect(entry.project).not.toBe("installation");
      expect(entry.clone_url).toEqual(expect.any(String));
      expect(entry.clone_url.length).toBeGreaterThan(0);
      expect(Number.isInteger(entry.reader_port)).toBe(true);
      expect(entry.reader_port).toBeGreaterThanOrEqual(1);
      expect(entry.reader_port).toBeLessThanOrEqual(65535);
      expect(users.has(entry.user)).toBe(false);
      expect(projects.has(entry.project)).toBe(false);
      expect(ports.has(entry.reader_port)).toBe(false);
      users.add(entry.user);
      projects.add(entry.project);
      ports.add(entry.reader_port);
    }
  });

  it.each([
    ["outdoor", outdoorConfigPath],
    ["outdoorpub", outdoorpubConfigPath],
    ["sandbar", sandbarConfigPath],
  ])("ships a syntactically loadable %s config", (_name, path) => {
    const result = spawnSync(process.execPath, ["--check", fileURLToPath(path)], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("ships outdoor's explicit checkout, mapped settings, gate file and its own image recipe", () => {
    expect(outdoorConfig).toContain('import { readEnvFile, splitRoleRouting } from "sandbar";');
    expect(outdoorConfig).toContain('const cwd = "/home/outdoor/outdoor";');
    expect(outdoorConfig).toContain('readFileSync(join(cwd, "gate/stack.json"), "utf8")');
    // #186: the stack itself is read from the source tip, not from the clone.
    expect(outdoorConfig).toContain('gateStack: { path: "gate/stack.json" },');
    expect(outdoorConfig).toMatch(/copyToWorktree:[\s\S]*?from:[\s\S]*?to:/);
    expect(outdoorConfig).toContain('const sandboxImage = "localhost/sandbar:outdoor";');
    expect(outdoorConfig).toContain('containerfile: "Containerfile.sandbar"');
  });

  // outdoorpub has no backend, database or CI: one image serves the agent
  // and the gate runner, the gate is the checkout's own script, the landing
  // is direct because no check run exists to verify it, and nothing lands
  // without review unless an issue opts in.
  it("ships outdoorpub's one-image gate, direct landing and review lane", () => {
    expect(outdoorpubConfig).toContain('import { readEnvFile, splitRoleRouting } from "sandbar";');
    expect(outdoorpubConfig).toContain('const cwd = "/home/outdoorpub/outdoorpub";');
    expect(outdoorpubConfig).toContain('const sandboxImage = "localhost/sandbar:outdoorpub";');
    expect(outdoorpubConfig).toContain('containerfile: "Containerfile"');
    expect(outdoorpubConfig).toMatch(/containers:\s*\[\s*\{ name: "runner", image: sandboxImage,/);
    expect(outdoorpubConfig).toContain('command: ["bash", "scripts/gate.sh"]');
    expect(outdoorpubConfig).toContain('mergeMode: { kind: "direct" }');
    expect(outdoorpubConfig).toContain('defaultLane: "review"');
    expect(outdoorpubConfig).toContain('claudeMdPath: "AGENTS.md"');
    expect(outdoorpubConfig).not.toContain("copyToWorktree");
  });

  it("ships sandbar's external config", () => {
    expect(sandbarConfig).toContain('import { readEnvFile, splitRoleRouting } from "sandbar";');
    expect(sandbarConfig).toContain('const cwd = "/home/sandbar/sandbar";');
    expect(sandbarConfig).toMatch(
      /promptExtensions:[\s\S]*?merger:[\s\S]*?one patch bump above the higher/,
    );
  });

  // The driver is this checkout's build (#146), so the checkout's own version is
  // what every installation config's floor has to be satisfied by.
  it.each(installations)("$project's config floor is met by this checkout", (entry) => {
    const config = installationConfigs.get(entry.user);
    if (config === undefined) {
      throw new Error(`missing committed installation config for ${entry.user}`);
    }
    const checkout = parseVersion(packageVersion.version);
    expect(checkout).not.toBeNull();
    expect(compareVersions(checkout!, requiredVersion(config))).toBeGreaterThanOrEqual(0);
  });

  it("assigns distinct host ports to every daemon and reader", () => {
    const daemonPorts = [outdoorConfig, outdoorpubConfig, sandbarConfig].map((config) => {
      const value = config.match(/^\s*uiPort:\s*(\d+),$/m)?.[1];
      if (value === undefined) throw new Error("installation config lacks uiPort");
      return Number(value);
    });
    const readerPorts = installations.map((entry) => entry.reader_port);
    expect(new Set([...daemonPorts, ...readerPorts]).size)
      .toBe(daemonPorts.length + readerPorts.length);
  });

  it.each([
    ["outdoor", outdoorConfig],
    ["outdoorpub", outdoorpubConfig],
    ["sandbar", sandbarConfig],
  ])("reads Codex auth only when a %s role routes to Codex", (_name, config) => {
    expect(config).toMatch(/Object\.entries\(routing\)[\s\S]*?field\.endsWith\("Agent"\) && provider === "codex"/);
    expect(config).toMatch(/\.\.\.\(usesCodex[\s\S]*?CODEX_AUTH_JSON:[\s\S]*?: \{\}\)/);
  });
});

// Innermost-first `{% if name %}...{% endif %}` with Ansible's trim_blocks: the
// newline right after a block tag is not output.
const IF_BLOCK = /\{%\s*if ([A-Za-z_][A-Za-z0-9_]*)\s*%\}\n?((?:(?!\{%)[\s\S])*?)\{%\s*endif\s*%\}\n?/;

function renderConditionals(template: string, vars: Readonly<Record<string, string>>): string {
  let text = template;
  for (let match = IF_BLOCK.exec(text); match !== null; match = IF_BLOCK.exec(text)) {
    const value = vars[match[1]!];
    if (value === undefined) throw new Error(`unrendered condition ${match[1]}`);
    text = text.slice(0, match.index) + (value === "" ? "" : match[2]!) + text.slice(match.index + match[0].length);
  }
  return render(text, vars);
}

type DumpBox = {
  readonly script: string;
  readonly drop: string;
  readonly incoming: string;
  readonly bin: string;
  readonly log: string;
};

// The rrsync stub writes a dot-temp file mode 0600 the way rsync does under
// prod's umask, then renames it into place unless told to fail first.
const RRSYNC_STUB = `#!/bin/sh
set -eu
echo "$*" >>"$DUMP_STUB_LOG"
for dir in "$@"; do :; done
printf '%s' "$DUMP_STUB_CONTENT" >"$dir/.outdoor-latest.sql.gz.Xq1"
chmod 0600 "$dir/.outdoor-latest.sql.gz.Xq1"
[ -z "\${DUMP_STUB_SYMLINK:-}" ] || ln -s /etc/passwd "$dir/evil"
[ "\${DUMP_STUB_EXIT:-0}" -eq 0 ] || exit "$DUMP_STUB_EXIT"
mv "$dir/.outdoor-latest.sql.gz.Xq1" "$dir/outdoor-latest.sql.gz"
`;

function dumpBox(): DumpBox {
  const root = mkdtempSync(join(tmpdir(), "sandbar-dump-"));
  dumpBoxes.push(root);
  const box: DumpBox = {
    script: join(root, "sandbar-dump-receive"),
    drop: join(root, "drop"),
    incoming: join(root, "drop/incoming"),
    bin: join(root, "bin"),
    log: join(root, "stub.log"),
  };
  for (const dir of [box.incoming, box.bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(box.bin, "rrsync"), RRSYNC_STUB, { mode: 0o755 });
  writeFileSync(join(box.bin, "logger"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(box.script, render(dumpReceiveTemplate, { sandbar_rrsync: join(box.bin, "rrsync") }));
  return box;
}

function runDump(box: DumpBox, env: Readonly<Record<string, string>> = {}, prefix: readonly string[] = []) {
  const [command, ...argv] = [...prefix, "/bin/sh", box.script, box.drop];
  return spawnSync(command!, argv, {
    encoding: "utf8",
    env: {
      PATH: `${box.bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      DUMP_STUB_LOG: box.log,
      DUMP_STUB_CONTENT: "dump-of-today",
      ...env,
    },
  });
}

const PUSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBk outdoor-prod-push";

function renderDumpKeys(key: string, from = ""): string {
  return renderConditionals(dumpKeysTemplate, {
    sandbar_dump_push_key: key,
    sandbar_dump_push_from: from,
    sandbar_dump_receive: roleDefault("sandbar_dump_receive"),
    sandbar_dump_drop: "/srv/sandbar-db/drops/outdoor",
  });
}

describe("sandbar-dump-receive, the dump-drop forced command (#200)", () => {
  it("is a shell program once the role has rendered it", () => {
    const box = dumpBox();
    expect(spawnSync("/bin/sh", ["-n", box.script]).status).toBe(0);
  });

  it("stages through write-only rrsync and publishes the file whole and group-readable", () => {
    const box = dumpBox();
    const result = runDump(box);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(box.log, "utf8")).toBe(`-wo -no-del -no-lock ${box.incoming}\n`);
    const published = join(box.drop, "outdoor-latest.sql.gz");
    expect(readFileSync(published, "utf8")).toBe("dump-of-today");
    expect(statSync(published).mode & 0o777).toBe(0o640);
    expect(readdirSync(box.incoming)).toEqual([]);
  });

  it("leaves yesterday's dump byte-identical when a push fails, and exits with its status", () => {
    const box = dumpBox();
    const published = join(box.drop, "outdoor-latest.sql.gz");
    writeFileSync(published, "dump-of-yesterday", { mode: 0o640 });
    const result = runDump(box, { DUMP_STUB_EXIT: "23" });
    expect(result.status).toBe(23);
    expect(readFileSync(published, "utf8")).toBe("dump-of-yesterday");
  });

  it("clears a killed push's leftovers before the next one", () => {
    const box = dumpBox();
    expect(runDump(box, { DUMP_STUB_EXIT: "23" }).status).toBe(23);
    mkdirSync(join(box.incoming, "stale-dir"));
    writeFileSync(join(box.incoming, "stale"), "partial");
    const result = runDump(box);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(box.incoming)).toEqual([]);
    expect(readdirSync(box.drop).sort()).toEqual(["incoming", "outdoor-latest.sql.gz"]);
  });

  it("refuses a second push while one holds the staging lock, without transferring", () => {
    const box = dumpBox();
    const result = runDump(box, {}, ["flock", box.incoming]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a push is already running");
    expect(existsSync(box.log)).toBe(false);
  });

  it("never publishes a symlink", () => {
    const box = dumpBox();
    const result = runDump(box, { DUMP_STUB_SYMLINK: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(box.drop, "evil"))).toBe(false);
    expect(readFileSync(join(box.drop, "outdoor-latest.sql.gz"), "utf8")).toBe("dump-of-today");
  });
});

describe("the database volume and dump drops (#200)", () => {
  const groupVars = parse(groupVarsSource) as unknown as GroupVars;

  it("formats only a volume with no signature, with reflink and without -f", () => {
    const probe = taskNamed(dbVolumeTasks, "Probe the database volume for any signature");
    expect(probe).toContain("blkid -p -o export {{ sandbar_db_volume }}");
    expect(probe).toContain("failed_when: sandbar_db_probe.rc not in [0, 2]");
    const refusal = taskNamed(dbVolumeTasks, "Refuse a database volume that holds anything but XFS");
    expect(refusal).toContain("sandbar_db_probe.rc == 2");
    expect(refusal).toContain("'TYPE=xfs' in sandbar_db_probe.stdout_lines");
    expect(refusal).toContain("select('match', '^PTTYPE=')");
    const mkfs = taskNamed(dbVolumeTasks, "Format the blank database volume as XFS with reflink");
    expect(mkfs).toContain("mkfs.xfs -m reflink=1 -L {{ sandbar_db_label }} {{ sandbar_db_volume }}");
    expect(mkfs).toContain("- sandbar_db_probe.rc == 2");
    expect(mkfs).not.toMatch(/\s-f\b/);
    expect(dbVolumeTasks.match(/command: mkfs/g)).toHaveLength(1);
    expect(dbVolumeTasks.indexOf("Refuse a database volume that holds anything but XFS"))
      .toBeLessThan(dbVolumeTasks.indexOf("Format the blank database volume as XFS with reflink"));
  });

  it("writes fstab without mounting, mounts only an empty mount point and never remounts", () => {
    const fstab = taskNamed(dbVolumeTasks, "Record the database volume in fstab without mounting it");
    expect(fstab).toContain("state: present");
    expect(fstab).toContain("fstype: xfs");
    expect(fstab).toContain('src: "{{ sandbar_db_volume }}"');
    expect(String(roleDefaults["sandbar_db_mount_opts"]).split(",")).toEqual(
      expect.arrayContaining(["discard", "nofail"]),
    );
    const mount = taskNamed(dbVolumeTasks, "Mount the database volume when nothing is mounted there");
    expect(mount).toContain("mount {{ sandbar_db_mount }}");
    expect(mount).toContain("- sandbar_db_mounted.rc == 1");
    expect(dbVolumeTasks).not.toMatch(/state:\s*(mounted|remounted)/);
  });

  it("refuses a mount that is not the declared volume as XFS with reflink", () => {
    const check = taskNamed(
      dbVolumeTasks,
      "Refuse a mount point that is not the declared volume as XFS with reflink",
    );
    expect(check).toContain("sandbar_db_device.stat.lnk_source");
    expect(check).toContain("== 'xfs'");
    expect(check).toContain("'reflink=1' in sandbar_db_xfs_info.stdout");
    expect(taskNamed(dbVolumeTasks, "Refuse a declared database volume that is not attached"))
      .toContain("is not attached; attach it or clear");
  });

  it("keeps every volume task conditional on a declared volume", () => {
    const tasks = parse(dbVolumeTasks) as readonly { readonly name: string; readonly when?: unknown }[];
    for (const task of tasks) {
      expect([task.when].flat(), task.name).toContain("sandbar_db_volume | length > 0");
    }
    expect(roleDefaults["sandbar_db_volume"]).toBe("");
    expect(taskNamed(accountTasks, "Provide the installation's share of the database volume"))
      .toContain("when: sandbar_db_volume | length > 0");
    expect(mainTasks.indexOf("import_tasks: swap.yml"))
      .toBeLessThan(mainTasks.indexOf("import_tasks: db-volume.yml"));
    expect(packageTasks).toMatch(/^\s+- rsync$/m);
    expect(packageTasks).toMatch(/^\s+- xfsprogs$/m);
  });

  it("names the volume only in inventory, never in the role", () => {
    expect(groupVars.sandbar_db_volume).toMatch(/^\/dev\/disk\/by-id\//);
    for (const source of [roleDefaultsSource, mainTasks, dbVolumeTasks, dbInstallationTasks, userTasks]) {
      expect(source).not.toContain(groupVars.sandbar_db_volume!);
      expect(source).not.toContain("HC_Volume");
    }
  });

  it("keeps the mount point and both trees root-owned, and each installation's dir its own", () => {
    const point = taskNamed(dbVolumeTasks, "Create the database volume mount point");
    expect(point).toContain("owner: root");
    expect(point).toContain('mode: "0755"');
    const trees = taskNamed(dbVolumeTasks, "Create the volume's per-installation and dump-drop trees");
    expect(trees).toContain('- "{{ sandbar_db_mount }}/installations"');
    expect(trees).toContain('- "{{ sandbar_db_mount }}/drops"');
    expect(trees).toContain("owner: root");
    expect(dbVolumeTasks.indexOf("Refuse a mount point that is not the declared volume"))
      .toBeLessThan(dbVolumeTasks.indexOf("Create the volume's per-installation and dump-drop trees"));
    const own = taskNamed(dbInstallationTasks, "Create the installation's directory on the database volume");
    expect(own).toContain('path: "{{ sandbar_db_mount }}/installations/{{ sandbar_user }}"');
    expect(own).toContain('owner: "{{ sandbar_user }}"');
    expect(own).toContain('mode: "0700"');
    expect(taskNamed(accountTasks, "Provide the installation's share of the database volume"))
      .toContain('sandbar_dump_drop: "{{ sandbar_db_mount }}/drops/{{ sandbar_user }}"');
  });

  it("makes the dump user a system account that cannot change its own key", () => {
    const account = taskNamed(dbInstallationTasks, "Create the dump-drop account");
    expect(account).toContain("system: true");
    expect(account).toContain("shell: /bin/sh");
    expect(account).toContain('password: "*"');
    expect(account).toContain("create_home: false");
    const home = taskNamed(dbInstallationTasks, "Create the dump-drop account's root-owned home and key directory");
    expect(home).toContain("owner: root");
    expect(home).toContain("/.ssh");
    const keys = taskNamed(
      dbInstallationTasks,
      "Authorize the prod push key, and nothing else, under the forced command",
    );
    expect(keys).toContain("src: dump-authorized_keys.j2");
    expect(keys).toContain("owner: root");
    expect(keys).toContain('mode: "0644"');
    const drop = taskNamed(dbInstallationTasks, "Create the dump drop and its staging directory");
    expect(drop).toContain('group: "{{ sandbar_user }}"');
    expect(drop).toContain('mode: "02750"');
    expect(drop).toContain('mode: "02700"');
  });

  it("authorizes exactly the push key, forced and restricted, or nothing", () => {
    expect(renderDumpKeys(PUSH_KEY)).toBe(
      `command="/usr/local/libexec/sandbar-dump-receive /srv/sandbar-db/drops/outdoor",restrict ${PUSH_KEY}\n`,
    );
    expect(renderDumpKeys(PUSH_KEY, "203.0.113.7")).toBe(
      `command="/usr/local/libexec/sandbar-dump-receive /srv/sandbar-db/drops/outdoor",restrict,from="203.0.113.7" ${PUSH_KEY}\n`,
    );
    expect(renderDumpKeys("")).toBe("");
  });

  it("validates every dump drop before host tasks", () => {
    const check = taskNamed(mainTasks, "Validate every dump drop an installation declares");
    expect(check).toContain("- sandbar_db_volume | length > 0");
    expect(check).toContain("item.dump_drop.user not in (sandbar_installations | map(attribute='user') | list)");
    expect(check).toContain("(item.dump_drop.user | default('')) != 'root'");
    expect(check).toContain("select('equalto', item.dump_drop.user) | list | length) == 1");
    expect(check).toContain("'\\n' not in (item.dump_drop.push_key | default(''))");
    expect(check).toContain("selectattr('dump_drop', 'defined')");
    const keyPattern = check.match(/push_key is match\('([^']+)'\)/)?.[1];
    if (keyPattern === undefined) throw new Error("dump drop validation lacks its key pattern");
    const key = new RegExp(keyPattern);
    expect(key.test(PUSH_KEY)).toBe(true);
    expect(key.test("ecdsa-sha2-nistp256 AAAAE2VjZHNh= prod")).toBe(true);
    expect(key.test(`command="/bin/sh",no-pty ${PUSH_KEY}`)).toBe(false);
    expect(key.test(`restrict ${PUSH_KEY}`)).toBe(false);
    expect(key.test("ssh-rsa AAAAB3NzaC1yc2E prod")).toBe(false);
    const fromPattern = check.match(/push_from \| string\) is match\('([^']+)'\)/)?.[1];
    if (fromPattern === undefined) throw new Error("dump drop validation lacks its push_from pattern");
    const from = new RegExp(fromPattern);
    expect(from.test("203.0.113.7,2001:db8::/32")).toBe(true);
    expect(from.test('1.2.3.4",command="x')).toBe(false);
    expect(mainTasks.indexOf("Validate every dump drop an installation declares"))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
  });

  it("declares outdoor's drop in inventory with a bare key or none", () => {
    const drops = installations.filter((row) => row.dump_drop !== undefined);
    expect(drops.map((row) => [row.user, row.dump_drop!.user])).toEqual([["outdoor", "outdoor-dump"]]);
    const users = new Set(installations.map((row) => row.user));
    for (const row of drops) {
      expect(row.dump_drop!.user).toMatch(SAFE_USER);
      expect(users.has(row.dump_drop!.user)).toBe(false);
      expect(row.dump_drop!.push_key === "" || /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)) /.test(row.dump_drop!.push_key))
        .toBe(true);
    }
  });

  it("refuses a subordinate id range change while the installation's volume dir holds files", () => {
    const find = taskNamed(userTasks, "Check for the installation's files on the database volume");
    expect(find).toContain('paths: "{{ sandbar_db_mount }}/installations/{{ sandbar_user }}"');
    expect(find).toContain("file_type: any");
    expect(find).toContain("hidden: true");
    const refusal = taskNamed(userTasks, "Refuse to move a subordinate id range under existing podman storage");
    expect(refusal).toContain("(sandbar_db_files.matched | default(0)) == 0");
    expect(refusal).toContain("{{ sandbar_db_mount }}/installations/{{ sandbar_user }}");
    expect(userTasks.indexOf("Check for the installation's files on the database volume"))
      .toBeLessThan(userTasks.indexOf("Refuse to move a subordinate id range under existing podman storage"));
  });
});

describe("the nightly base import (#201)", () => {
  // A config's `databaseCopies` paths, as the committed text spells them.
  const databaseCopiesOf = (config: string) => {
    const block = config.match(/^\s*databaseCopies: \{\n([\s\S]*?)\n\s*\},$/m)?.[1];
    if (block === undefined) return null;
    const field = (name: string) => block.match(new RegExp(`^\\s*${name}: "([^"]+)",$`, "m"))?.[1];
    return { dump: field("dump"), root: field("root"), container: field("container") };
  };

  it.each(installations)("renders $project's import as a oneshot outside the daemon's unit", (row) => {
    const unit = render(dbBaseServiceTemplate, varsFor(row));
    expect(unit).not.toMatch(/\{\{|\}\}/);
    expect(values(unit, "Type")).toEqual(["oneshot"]);
    expect(values(unit, "WorkingDirectory")).toEqual([`/home/${row.user}/${row.project}`]);
    expect(values(unit, "ExecStart")).toEqual([
      `/usr/bin/node ${DRIVER_CURRENT}/dist/cli.js db-base --config /home/${row.user}/installation/sandbar.config.mjs`,
    ]);
    expect(values(unit, "TimeoutStartSec")).toEqual(["5h"]);
    // A deploy restart of the daemon must neither kill nor wait on an import.
    expect(values(unit, "PartOf")).toEqual([]);
    expect(values(unit, "Requires")).toEqual([]);
    expect(values(unit, "WantedBy")).toEqual([]);
  });

  it("runs every 15 minutes and catches up after downtime", () => {
    const timer = render(dbBaseTimerTemplate, { sandbar_project: "outdoor" });
    expect(values(timer, "OnCalendar")).toEqual(["*:0/15"]);
    expect(values(timer, "Persistent")).toEqual(["true"]);
    expect(values(timer, "WantedBy")).toEqual(["timers.target"]);
  });

  it("installs and starts the timer only for an installation with a dump drop", () => {
    const include = taskNamed(installationTasks, "Install the database base import timer");
    expect(include).toContain("ansible.builtin.include_tasks: db-base.yml");
    expect(include).toContain("when: sandbar_installation.dump_drop is defined");
    const install = taskNamed(dbBaseTasks, "Install the database base import unit and its timer");
    expect(install).toContain("- sandbar-db-base.service");
    expect(install).toContain("- sandbar-db-base.timer");
    expect(install).toContain('dest: "{{ sandbar_home }}/.config/systemd/user/{{ item }}"');
    const enable = taskNamed(dbBaseTasks, "Enable and start the database base import timer");
    expect(enable).toContain("name: sandbar-db-base.timer");
    expect(enable).toContain("scope: user");
    expect(enable).toContain("state: started");
    // The daemon's own unit is never started by the play (#146).
    expect(dbBaseTasks).not.toContain("sandbar.service");
  });

  it.each(installations)("points $project's databaseCopies at its own drop and volume dir, or sets none", (row) => {
    const mount = roleDefault("sandbar_db_mount");
    const dbc = databaseCopiesOf(installationConfigs.get(row.user)!);
    if (row.dump_drop === undefined) {
      expect(dbc).toBeNull();
      return;
    }
    expect(dbc).toEqual({
      dump: `${mount}/drops/${row.user}/outdoor-latest.sql.gz`,
      root: `${mount}/installations/${row.user}`,
      container: "db",
    });
  });
});
