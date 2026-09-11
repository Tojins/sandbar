// The per-installation systemd units, the convergence timer and the host-global
// role shipped by deploy/ansible (#149, #146). Tests parse the committed
// group_vars, render the units and pages from the real entries, and inspect
// bounded Ansible tasks so deleting one loop or include cannot be hidden by a
// later task with similar text.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { EXIT_CODE_RESTART } from "./exit-conditions.js";
import { RESTART_REQUEST_FILE } from "./restart-request.js";
import { compareVersions, parseVersion } from "./requires-sandbar.js";

const ROLE = new URL("../deploy/ansible/roles/sandbar/", import.meta.url);
const DEPLOY_ROOT = new URL("../deploy/ansible/", import.meta.url);
const daemonTemplate = readFileSync(new URL("templates/sandbar.service.j2", ROLE), "utf8");
const uiTemplate = readFileSync(new URL("templates/sandbar-ui.service.j2", ROLE), "utf8");
const pullServiceTemplate = readFileSync(new URL("templates/sandbar-pull.service.j2", ROLE), "utf8");
const pullTimerTemplate = readFileSync(new URL("templates/sandbar-pull.timer.j2", ROLE), "utf8");
const pullScriptTemplate = readFileSync(new URL("templates/sandbar-pull.sh.j2", ROLE), "utf8");
const caddyTemplate = readFileSync(new URL("templates/Caddyfile.j2", ROLE), "utf8");
const indexTemplate = readFileSync(new URL("templates/index.html.j2", ROLE), "utf8");
const roleDefaults = readFileSync(new URL("defaults/main.yml", ROLE), "utf8");
const mainTasks = readFileSync(new URL("tasks/main.yml", ROLE), "utf8");
const accountTasks = readFileSync(new URL("tasks/account.yml", ROLE), "utf8");
const installationTasks = readFileSync(new URL("tasks/installation.yml", ROLE), "utf8");
const prepareTasks = readFileSync(new URL("tasks/prepare-installation.yml", ROLE), "utf8");
const caddyTasks = readFileSync(new URL("tasks/caddy.yml", ROLE), "utf8");
const driverTasks = readFileSync(new URL("tasks/driver.yml", ROLE), "utf8");
const pullTasks = readFileSync(new URL("tasks/pull.yml", ROLE), "utf8");
const groupVarsSource = readFileSync(new URL("group_vars/all.yml", DEPLOY_ROOT), "utf8");
const inventorySource = readFileSync(new URL("inventory.yml", DEPLOY_ROOT), "utf8");
const outdoorConfigPath = new URL("installations/outdoor/sandbar.config.mjs", DEPLOY_ROOT);
const sandbarConfigPath = new URL("installations/sandbar/sandbar.config.mjs", DEPLOY_ROOT);
const outdoorConfig = readFileSync(outdoorConfigPath, "utf8");
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
  readonly config_src?: string;
};

type GroupVars = {
  readonly sandbar_installations?: readonly InventoryInstallation[];
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
      "installation.project": row.project,
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

const installations = installationsFrom(groupVarsSource);
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
    const defaults = parse(roleDefaults) as Record<string, unknown>;
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
    expect(roleDefaults).not.toContain("driver_tag");
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
    expect(request).toContain('content: "{{ sandbar_driver_commit }}\\n"');
    expect(request).toContain(
      'dest: "{{ sandbar_installation_dir }}/{{ sandbar_restart_request_file }}"',
    );
    expect(request).toContain('owner: "{{ sandbar_user }}"');
    for (const trigger of [
      "sandbar_driver_flip is changed",
      "sandbar_installation_files_changed[sandbar_user] | default(false)",
      "sandbar_daemon_unit is changed",
      "sandbar_ui_unit is changed",
    ]) {
      expect(request).toContain(trigger);
    }
    // The play never starts or restarts a daemon itself.
    expect(installationTasks).not.toContain("state: restarted");
    expect(installationTasks).not.toContain("state: started");
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

  it("runs one ansible-pull against main and records every attempt", () => {
    const script = render(pullScriptTemplate, {
      sandbar_ui_root: UI_ROOT,
      sandbar_deploy_status_file: DEPLOY_STATUS,
      sandbar_driver_repo: DRIVER_REPO,
      sandbar_driver_branch: DRIVER_BRANCH,
      sandbar_pull_dir: PULL_DIR,
    });
    expect(script).not.toMatch(/\{\{|\}\}/);
    expect(script).toContain("--only-if-changed");
    expect(script).toContain(`--url ${DRIVER_REPO}`);
    expect(script).toContain(`--checkout ${DRIVER_BRANCH}`);
    expect(script).toContain(`--directory ${PULL_DIR}`);
    expect(script).toContain("--inventory localhost,");
    expect(script).toContain("deploy/ansible/site.yml");
    // Written on failure too, and atomically, so a half-written status can
    // never be what the index page reads.
    expect(script).toContain(`status=${UI_ROOT}/${DEPLOY_STATUS}`);
    expect(script).toContain('mv "$status.new" "$status"');
    expect(script).toContain('exit "$result"');
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
    expect(renderPerInstallation(caddyTemplate, installations, {
      sandbar_ui_http_port: "80",
      sandbar_ui_root: UI_ROOT,
    })).toBe(`:80 {
\thandle_path /outdoor/* {
\t\treverse_proxy 127.0.0.1:7332
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
    expect(page).toContain('<li><a href="/outdoor/">outdoor</a></li>\n<li><a href="/sandbar/">sandbar</a></li>');
    expect(page.indexOf('href="/outdoor/"')).toBeLessThan(page.indexOf('href="/sandbar/"'));
    expect(page).toContain(`fetch("${DEPLOY_STATUS}", { cache: "no-store" })`);
    expect(page).toContain('document.getElementById("deploy")');
    expect(page).toContain("No convergence recorded yet");
    const renderTask = taskNamed(caddyTasks, "Render the installation index");
    expect(renderTask).toContain("src: index.html.j2");
    expect(renderTask).toContain('dest: "{{ sandbar_ui_root }}/index.html"');
    expect(caddyTasks.indexOf("- name: Render the installation index"))
      .toBeLessThan(caddyTasks.indexOf("- name: Configure Caddy installation routes and index"));
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
    expect(installations).toHaveLength(2);
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
