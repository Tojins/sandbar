// The per-installation systemd units and host-global role shipped by
// deploy/ansible (#149). Tests parse the committed inventories, render the
// units from the real entries, and inspect bounded Ansible tasks so deleting
// one loop or include cannot be hidden by a later task with similar text.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROLE = new URL("../deploy/ansible/roles/sandbar/", import.meta.url);
const DEPLOY_ROOT = new URL("../deploy/ansible/", import.meta.url);
const daemonTemplate = readFileSync(new URL("templates/sandbar.service.j2", ROLE), "utf8");
const uiTemplate = readFileSync(new URL("templates/sandbar-ui.service.j2", ROLE), "utf8");
const caddyTemplate = readFileSync(new URL("templates/Caddyfile.j2", ROLE), "utf8");
const mainTasks = readFileSync(new URL("tasks/main.yml", ROLE), "utf8");
const accountTasks = readFileSync(new URL("tasks/account.yml", ROLE), "utf8");
const installationTasks = readFileSync(new URL("tasks/installation.yml", ROLE), "utf8");
const prepareTasks = readFileSync(new URL("tasks/prepare-installation.yml", ROLE), "utf8");
const caddyTasks = readFileSync(new URL("tasks/caddy.yml", ROLE), "utf8");
const exampleInventorySource = readFileSync(new URL("inventory.example.yml", DEPLOY_ROOT), "utf8");
const realInventorySource = readFileSync(new URL("inventory.yml", DEPLOY_ROOT), "utf8");
const outdoorConfigPath = new URL("installations/outdoor/sandbar.config.mjs", DEPLOY_ROOT);
const sandbarConfigPath = new URL("installations/sandbar/sandbar.config.mjs", DEPLOY_ROOT);
const outdoorConfig = readFileSync(outdoorConfigPath, "utf8");
const sandbarConfig = readFileSync(sandbarConfigPath, "utf8");

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
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

const realInventory = inventoryVars(realInventorySource);
const installations = realInventory.sandbar_installations.map((entry) => ({
  ...entry,
  driver_tag: entry.driver_tag ?? realInventory.sandbar_driver_tag,
}));

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
      `/usr/bin/node /home/${row.user}/installation/driver/node_modules/sandbar/dist/cli.js ui --port ${row.reader_port}`,
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
      ["Configure Caddy for the first installation", "caddy.yml"],
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
    expect(taskNamed(prepareTasks, "Install the shared driver reconciliation module"))
      .toContain("src: driver-install.mjs");
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
    const unique = taskNamed(mainTasks, "Refuse installation users or reader ports that are not unique");
    expect(unique).toContain("map(attribute='user')");
    expect(unique).toContain("map(attribute='reader_port')");
    expect(mainTasks.indexOf("Validate every installation inventory entry"))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
    expect(mainTasks.indexOf("Refuse installation users or reader ports that are not unique"))
      .toBeLessThan(mainTasks.indexOf("Install host packages"));
  });

  it("leaves Caddy on the first reader until prefix routing lands", () => {
    expect(render(caddyTemplate, {
      sandbar_ui_http_port: "80",
      sandbar_caddy_reader_port: String(installations[0]?.reader_port),
    })).toBe(":80 {\n\treverse_proxy 127.0.0.1:7332\n}\n");
    expect(taskNamed(caddyTasks, "Configure Caddy for the first installation reader"))
      .toContain("notify: Reload Caddy");
    expect(taskNamed(caddyTasks, "Apply the Caddy configuration before installation checks can stop the play"))
      .toContain("ansible.builtin.meta: flush_handlers");
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

  it("ships outdoor's explicit checkout, mapped settings, gate file and neutral image", () => {
    expect(outdoorConfig).toContain('import { readEnvFile, splitRoleRouting } from "sandbar";');
    expect(outdoorConfig).toContain('const cwd = "/home/outdoor/outdoor";');
    expect(outdoorConfig).toContain('readFileSync(join(cwd, "gate/stack.json"), "utf8")');
    expect(outdoorConfig).toMatch(/copyToWorktree:[\s\S]*?from:[\s\S]*?to:/);
    expect(outdoorConfig).toContain('const image = "localhost/outdoor:dev";');
    expect(outdoorConfig).toContain('containerfile: "Containerfile.dev"');
  });

  it("ships sandbar's external config and records its lagging driver rule", () => {
    expect(sandbarConfig).toContain('import { readEnvFile, splitRoleRouting } from "sandbar";');
    expect(sandbarConfig).toContain('const cwd = "/home/sandbar/sandbar";');
    expect(realInventorySource).toMatch(
      /Self-hosting must lag the checkout:[\s\S]*?driver_tag: github:[^#\s]+#v\d+\.\d+\.\d+/,
    );
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
