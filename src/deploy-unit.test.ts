// The per-installation systemd units and host-global role shipped by
// deploy/ansible (#149, #155). Tests parse the committed inventories, render
// the units, the Caddy site and the VPN server from the real entries, and
// inspect bounded Ansible tasks so deleting one loop or include cannot be
// hidden by a later task with similar text.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { compareVersions, parseVersion } from "./requires-sandbar.js";

const ROLE = new URL("../deploy/ansible/roles/sandbar/", import.meta.url);
const DEPLOY_ROOT = new URL("../deploy/ansible/", import.meta.url);
const daemonTemplate = readFileSync(new URL("templates/sandbar.service.j2", ROLE), "utf8");
const uiTemplate = readFileSync(new URL("templates/sandbar-ui.service.j2", ROLE), "utf8");
const caddyTemplate = readFileSync(new URL("templates/Caddyfile.j2", ROLE), "utf8");
const indexTemplate = readFileSync(new URL("templates/index.html.j2", ROLE), "utf8");
const mainTasks = readFileSync(new URL("tasks/main.yml", ROLE), "utf8");
const accountTasks = readFileSync(new URL("tasks/account.yml", ROLE), "utf8");
const installationTasks = readFileSync(new URL("tasks/installation.yml", ROLE), "utf8");
const prepareTasks = readFileSync(new URL("tasks/prepare-installation.yml", ROLE), "utf8");
const caddyTasks = readFileSync(new URL("tasks/caddy.yml", ROLE), "utf8");
const vpnTasks = readFileSync(new URL("tasks/vpn.yml", ROLE), "utf8");
const handlers = readFileSync(new URL("handlers/main.yml", ROLE), "utf8");
const vpnServerTemplate = readFileSync(new URL("templates/openvpn-server.conf.j2", ROLE), "utf8");
const vpnScriptTemplate = readFileSync(new URL("templates/sandbar-vpn.j2", ROLE), "utf8");
const roleDefaults = parse(readFileSync(new URL("defaults/main.yml", ROLE), "utf8")) as Record<string, unknown>;
const exampleInventorySource = readFileSync(new URL("inventory.example.yml", DEPLOY_ROOT), "utf8");
const realInventorySource = readFileSync(new URL("inventory.yml", DEPLOY_ROOT), "utf8");
const outdoorConfigPath = new URL("installations/outdoor/sandbar.config.mjs", DEPLOY_ROOT);
const sandbarConfigPath = new URL("installations/sandbar/sandbar.config.mjs", DEPLOY_ROOT);
const outdoorConfig = readFileSync(outdoorConfigPath, "utf8");
const sandbarConfig = readFileSync(sandbarConfigPath, "utf8");
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly version: string };

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const INSTALLATION_LOOP = /\{%\s*for installation in sandbar_installations\s*%\}\n([\s\S]*?)\{%\s*endfor\s*%\}\n/g;
const EXACT_TAG = /^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#v\d+\.\d+\.\d+$/;
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type InventoryInstallation = {
  readonly user: string;
  readonly project: string;
  readonly clone_url: string;
  readonly reader_port: number;
  readonly driver_tag?: string;
  readonly config_src?: string;
};

type InventoryDocument = {
  readonly all?: {
    readonly vars?: {
      readonly sandbar_driver_tag?: string;
      readonly sandbar_installations?: readonly InventoryInstallation[];
    };
  };
};

function inventoryVars(source: string): {
  readonly sandbar_driver_tag: string;
  readonly sandbar_installations: readonly InventoryInstallation[];
} {
  const document = parse(source) as unknown as InventoryDocument;
  const driverTag = document.all?.vars?.sandbar_driver_tag;
  const installations = document.all?.vars?.sandbar_installations;
  if (typeof driverTag !== "string" || !Array.isArray(installations)) {
    throw new Error("inventory lacks sandbar_driver_tag or sandbar_installations");
  }
  return { sandbar_driver_tag: driverTag, sandbar_installations: installations };
}

function render(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`unrendered placeholder ${name}`);
    return value;
  });
}

function renderCaddy(
  template: string,
  rows: readonly InventoryInstallation[],
  httpPort: string,
): string {
  const expanded = template.replace(INSTALLATION_LOOP, (_match, body: string) =>
    rows.map((row) => render(body, {
      "installation.project": row.project,
      "installation.reader_port": String(row.reader_port),
    })).join(""));
  return render(expanded, {
    sandbar_ui_bind: roleDefault("sandbar_ui_bind"),
    sandbar_ui_http_port: httpPort,
    sandbar_ui_root: roleDefault("sandbar_ui_root"),
    sandbar_ui_access_log: roleDefault("sandbar_ui_access_log"),
  });
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
  const start = lines.findIndex((line) => line === marker);
  if (start === -1) throw new Error(`missing task ${JSON.stringify(name)}`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => line.startsWith("- name: "));
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

afterAll(() => {
  for (const root of vpnBoxes) rmSync(root, { recursive: true, force: true });
});

const realInventory = inventoryVars(realInventorySource);
const installations = realInventory.sandbar_installations.map((entry) => ({
  ...entry,
  driver_tag: entry.driver_tag ?? realInventory.sandbar_driver_tag,
}));
const installationConfigs = new Map([
  ["outdoor", outdoorConfig],
  ["sandbar", sandbarConfig],
]);

function requiredVersion(config: string) {
  const text = config.match(/^\s*requiresSandbar:\s*"([^"]+)",$/m)?.[1];
  const version = text === undefined ? null : parseVersion(text);
  if (version === null) throw new Error("installation config lacks valid requiresSandbar");
  return version;
}

function driverVersion(tag: string) {
  const text = tag.split("#v")[1];
  const version = text === undefined ? null : parseVersion(text);
  if (version === null) throw new Error(`inventory has invalid driver tag ${tag}`);
  return version;
}

function varsFor(row: (typeof installations)[number]): Record<string, string> {
  const home = `/home/${row.user}`;
  return {
    sandbar_project: row.project,
    sandbar_checkout: `${home}/${row.project}`,
    sandbar_installation_dir: `${home}/installation`,
    sandbar_installation_driver_tag: row.driver_tag,
    sandbar_reader_port: String(row.reader_port),
    sandbar_stop_timeout_sec: "900",
  };
}

describe.each(installations)("$project installation units", (row) => {
  const vars = varsFor(row);

  it("renders the daemon's exact driver and external config contract", () => {
    const unit = render(daemonTemplate, vars);
    expect(unit).not.toMatch(/\{\{|\}\}/);
    expect(unit).not.toContain("git pull");
    expect(unit).not.toContain("npm ci");
    expect(values(unit, "WorkingDirectory")).toEqual([`/home/${row.user}/${row.project}`]);
    expect(values(unit, "EnvironmentFile")).toEqual([`/home/${row.user}/installation/sandbar.env`]);
    expect(values(unit, "ExecStartPre")).toEqual([
      `/usr/bin/node /home/${row.user}/installation/install-driver.mjs ${row.driver_tag}`,
    ]);
    expect(values(unit, "ExecStart")).toEqual([
      `/usr/bin/node /home/${row.user}/installation/driver/node_modules/sandbar/dist/cli.js --config /home/${row.user}/installation/sandbar.config.mjs`,
    ]);
    expect(values(unit, "Restart")).toEqual(["no"]);
    expect(values(unit, "Requires")).toEqual(["podman.socket"]);
    expect(values(unit, "After")).toEqual(["podman.socket"]);
    expect(values(unit, "KillMode")).toEqual(["control-group"]);
    expect(values(unit, "ExitType")).toEqual(["cgroup"]);
    expect(values(unit, "TimeoutStopSec")).toEqual(["900"]);
    expect(values(unit, "WantedBy")).toEqual(["default.target"]);
  });

  it("renders the same driver's reader only after a successful daemon start", () => {
    const unit = render(uiTemplate, vars);
    expect(unit).not.toMatch(/\{\{|\}\}/);
    expect(values(unit, "Requires")).toEqual(["sandbar.service"]);
    expect(values(unit, "PartOf")).toEqual(["sandbar.service"]);
    expect(values(unit, "After")).toEqual(["sandbar.service"]);
    expect(values(unit, "ExecStartPre")).toEqual([]);
    expect(values(unit, "ExecStart")).toEqual([
      `/usr/bin/node /home/${row.user}/installation/driver/node_modules/sandbar/dist/cli.js ui --config /home/${row.user}/installation/sandbar.config.mjs --port ${row.reader_port}`,
    ]);
    expect(values(unit, "Restart")).toEqual(["no"]);
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

  it("prepares both role-owned driver files and optional installation config", () => {
    expect(taskNamed(prepareTasks, "Copy the installation configuration supplied by inventory"))
      .toContain("when: sandbar_installation.config_src is defined");
    expect(taskNamed(prepareTasks, "Install the role-owned driver installer"))
      .toContain("src: install-driver.mjs");
    const sharedInstaller = taskNamed(
      prepareTasks,
      "Install the shared driver reconciliation module",
    );
    expect(sharedInstaller).toContain("src: driver-install.mjs");
    expect(sharedInstaller).toContain(
      'dest: "{{ sandbar_installation_dir }}/driver-install.mjs"',
    );
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

  it("validates isolation-critical inventory fields before host tasks", () => {
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
    const unique = taskNamed(
      mainTasks,
      "Refuse installation identities, routes or reader ports that are not unique",
    );
    expect(unique).toContain("map(attribute='user')");
    expect(unique).toContain("map(attribute='project')");
    expect(unique).toContain("map(attribute='reader_port')");
    expect(mainTasks.indexOf("Validate every installation inventory entry"))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
    expect(mainTasks.indexOf(
      "Refuse installation identities, routes or reader ports that are not unique",
    ))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
  });

  it("renders one stripped-prefix route per reader and serves the static index", () => {
    expect(renderCaddy(caddyTemplate, installations, "80")).toBe(`:80 {
\tbind ${VPN_ADDRESS}
\tlog {
\t\toutput file /var/log/caddy/sandbar-ui.log
\t}
\thandle_path /outdoor/* {
\t\treverse_proxy 127.0.0.1:7332
\t}
\thandle_path /sandbar/* {
\t\treverse_proxy 127.0.0.1:7333
\t}
\troot * /var/www/sandbar
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

  it("renders an ordered installation index as a file Caddy 2.6 can serve", () => {
    expect(renderCaddy(indexTemplate, installations, "80")).toBe(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sandbar installations</title>
</head>
<body>
<h1>Sandbar installations</h1>
<ul>
<li><a href="/outdoor/">outdoor</a></li>
<li><a href="/sandbar/">sandbar</a></li>
</ul>
</body>
</html>
`);
    const renderTask = taskNamed(caddyTasks, "Render the installation index");
    expect(renderTask).toContain("src: index.html.j2");
    expect(renderTask).toContain('dest: "{{ sandbar_ui_root }}/index.html"');
    expect(caddyTasks.indexOf("- name: Render the installation index"))
      .toBeLessThan(caddyTasks.indexOf("- name: Configure Caddy installation routes and index"));
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

  it("keeps devices out of play state and out of the public inventory", () => {
    const commands = vpnTasks.split("\n")
      .filter((line) => line.trimStart().startsWith("ansible.builtin.command:"));
    expect(commands).toEqual(["  ansible.builtin.command: /usr/local/sbin/sandbar-vpn init"]);
    for (const source of [exampleInventorySource, realInventorySource]) {
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

describe("committed installation inventory and configs", () => {
  it.each([
    ["example", exampleInventorySource],
    ["real", realInventorySource],
  ])("validates every %s inventory entry", (_name, source) => {
    const inventory = inventoryVars(source);
    expect(inventory.sandbar_driver_tag).toMatch(EXACT_TAG);
    expect(inventory.sandbar_installations).toHaveLength(2);
    const users = new Set<string>();
    const ports = new Set<number>();
    for (const entry of inventory.sandbar_installations) {
      expect(entry.user).toMatch(SAFE_USER);
      expect(entry.user).not.toBe("root");
      expect(entry.project).toMatch(SAFE_PROJECT);
      expect(entry.project).not.toBe("installation");
      expect(entry.clone_url).toEqual(expect.any(String));
      expect(entry.clone_url.length).toBeGreaterThan(0);
      expect(Number.isInteger(entry.reader_port)).toBe(true);
      expect(entry.reader_port).toBeGreaterThanOrEqual(1);
      expect(entry.reader_port).toBeLessThanOrEqual(65535);
      expect(entry.driver_tag ?? inventory.sandbar_driver_tag).toMatch(EXACT_TAG);
      expect(users.has(entry.user)).toBe(false);
      expect(ports.has(entry.reader_port)).toBe(false);
      users.add(entry.user);
      ports.add(entry.reader_port);
    }
  });

  it.each([
    ["outdoor", outdoorConfigPath],
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
    expect(outdoorConfig).toMatch(/copyToWorktree:[\s\S]*?from:[\s\S]*?to:/);
    expect(outdoorConfig).toContain('const sandboxImage = "localhost/sandbar:outdoor";');
    expect(outdoorConfig).toContain('containerfile: "Containerfile.sandbar"');
  });

  it("ships sandbar's external config and records its lagging driver rule", () => {
    expect(sandbarConfig).toContain('import { readEnvFile, splitRoleRouting } from "sandbar";');
    expect(sandbarConfig).toContain('const cwd = "/home/sandbar/sandbar";');
    expect(sandbarConfig).toMatch(
      /promptExtensions:[\s\S]*?merger:[\s\S]*?one patch bump above the higher/,
    );
    expect(realInventorySource).toMatch(
      /Self-hosting must lag the checkout:[\s\S]*?driver_tag: github:[^#\s]+#v\d+\.\d+\.\d+/,
    );
    const entry = realInventory.sandbar_installations.find(({ user }) => user === "sandbar");
    const driver = entry?.driver_tag === undefined ? null : driverVersion(entry.driver_tag);
    const checkout = parseVersion(packageVersion.version);
    expect(driver).not.toBeNull();
    expect(checkout).not.toBeNull();
    expect(compareVersions(driver!, checkout!)).toBeLessThan(0);
  });

  it.each(installations)("$project's effective driver satisfies its config floor", (entry) => {
    const config = installationConfigs.get(entry.user);
    if (config === undefined) {
      throw new Error(`missing committed installation config for ${entry.user}`);
    }
    expect(
      compareVersions(driverVersion(entry.driver_tag), requiredVersion(config)),
    ).toBeGreaterThanOrEqual(0);
  });

  it("assigns distinct host ports to both daemons and readers", () => {
    const daemonPorts = [outdoorConfig, sandbarConfig].map((config) => {
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
    ["sandbar", sandbarConfig],
  ])("reads Codex auth only when a %s role routes to Codex", (_name, config) => {
    expect(config).toMatch(/Object\.entries\(routing\)[\s\S]*?field\.endsWith\("Agent"\) && provider === "codex"/);
    expect(config).toMatch(/\.\.\.\(usesCodex[\s\S]*?CODEX_AUTH_JSON:[\s\S]*?: \{\}\)/);
  });
});
