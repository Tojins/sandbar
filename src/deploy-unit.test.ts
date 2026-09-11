// The per-installation systemd units and host-global role shipped by
// deploy/ansible (#149, #155). Tests parse the committed inventories, render
// the units, the Caddy site and the VPN server from the real entries, and
// inspect bounded Ansible tasks so deleting one loop or include cannot be
// hidden by a later task with similar text.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
const vpnEnvTemplate = readFileSync(new URL("templates/vpn.env.j2", ROLE), "utf8");
const vpnScript = readFileSync(new URL("files/sandbar-vpn", ROLE), "utf8");
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
    sandbar_ui_bind: VPN_ADDRESS,
    sandbar_ui_http_port: httpPort,
    sandbar_ui_root: "/var/www/sandbar",
    sandbar_ui_access_log: "/var/log/caddy/sandbar-ui.log",
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

  it("grants a client the tunnel subnet and nothing else", () => {
    const server = render(vpnServerTemplate, {
      sandbar_vpn_port: "443",
      sandbar_vpn_proto: "tcp",
      sandbar_vpn_network: "10.8.0.0",
      sandbar_vpn_netmask: "255.255.255.0",
      sandbar_vpn_address: VPN_ADDRESS,
      sandbar_vpn_dir: "/etc/openvpn/sandbar",
    });
    expect(server).not.toMatch(/\{\{|\}\}/);
    expect(directives(server)).toContain("server 10.8.0.0 255.255.255.0");
    expect(directives(server)).toContain("proto tcp-server");
    for (const reach of ["push", "redirect-gateway", "client-to-client"]) {
      expect(directives(server).join("\n")).not.toContain(reach);
    }
    const forwarding = taskNamed(vpnTasks, "Forward nothing between this box's interfaces");
    expect(forwarding).toContain("name: net.ipv4.ip_forward");
    expect(forwarding).toContain('value: "0"');
  });

  it("verifies every certificate against a revocation list the server can read", () => {
    expect(directives(vpnServerTemplate))
      .toContain("crl-verify {{ sandbar_vpn_dir }}/crl.pem");
    expect(directives(vpnServerTemplate)).toContain("user nobody");
    // The list is published outside the root-only PKI the rest is read from.
    expect(vpnScript).toContain('CRL="$SANDBAR_VPN_DIR/crl.pem"');
    expect(vpnScript).toContain('install -m 0644 -o root -g root "$EASYRSA_PKI/crl.pem" "$CRL"');
    expect(vpnScript).toContain("EASYRSA_CRL_DAYS=3650");
  });

  it("initialises one certificate authority on the box and repeats no work", () => {
    const init = taskNamed(vpnTasks, "Initialise the certificate authority");
    expect(init).toContain("ansible.builtin.command: /usr/local/sbin/sandbar-vpn init");
    expect(init).toContain('creates: "{{ sandbar_vpn_dir }}/pki/issued/server.crt"');
    // A second init would issue a new CA under the profiles already handed out.
    expect(vpnScript).toContain('[ ! -e "$EASYRSA_PKI" ]');
    const script = taskNamed(vpnTasks, "Install the certificate authority script");
    expect(script).toContain("src: sandbar-vpn");
    expect(script).toContain('mode: "0700"');
    expect(vpnTasks.indexOf("- name: Install the certificate authority script"))
      .toBeLessThan(vpnTasks.indexOf("- name: Initialise the certificate authority"));
  });

  it("keeps devices out of play state and out of the public inventory", () => {
    expect(vpnScript).toContain("\tissue)");
    expect(vpnScript).toContain("\trevoke)");
    const commands = vpnTasks.split("\n")
      .filter((line) => line.trimStart().startsWith("ansible.builtin.command:"));
    expect(commands).toEqual(["  ansible.builtin.command: /usr/local/sbin/sandbar-vpn init"]);
    for (const source of [exampleInventorySource, realInventorySource]) {
      expect(source).not.toContain("sandbar-vpn");
      expect(source).not.toContain(".ovpn");
    }
  });

  it("renders one set of dial-in facts for the server and the profiles", () => {
    const vars = {
      sandbar_vpn_dir: "/etc/openvpn/sandbar",
      sandbar_vpn_endpoint: "203.0.113.5",
      sandbar_vpn_port: "443",
      sandbar_vpn_proto: "tcp",
    };
    expect(directives(render(vpnEnvTemplate, vars))).toEqual([
      "SANDBAR_VPN_DIR=/etc/openvpn/sandbar",
      "SANDBAR_VPN_ENDPOINT=203.0.113.5",
      "SANDBAR_VPN_PORT=443",
      "SANDBAR_VPN_PROTO=tcp",
    ]);
    expect(roleDefaults["sandbar_vpn_endpoint"])
      .toBe("{{ ansible_facts['default_ipv4']['address'] | default('') }}");
    expect(vpnScript).toContain("remote $SANDBAR_VPN_ENDPOINT $SANDBAR_VPN_PORT");
    expect(vpnScript).toContain("proto ${SANDBAR_VPN_PROTO}-client");
  });

  it("starts the server the rendered configuration names", () => {
    const configure = taskNamed(vpnTasks, "Configure the VPN server");
    expect(configure).toContain("dest: /etc/openvpn/server/sandbar.conf");
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
