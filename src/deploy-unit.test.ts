// The per-installation systemd units and host-global Caddyfile shipped by
// deploy/ansible (#149), table-tested as the exact strings two users receive.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROLE = new URL("../deploy/ansible/roles/sandbar/", import.meta.url);
const daemonTemplate = readFileSync(new URL("templates/sandbar.service.j2", ROLE), "utf8");
const uiTemplate = readFileSync(new URL("templates/sandbar-ui.service.j2", ROLE), "utf8");
const caddyTemplate = readFileSync(new URL("templates/Caddyfile.j2", ROLE), "utf8");
const mainTasks = readFileSync(new URL("tasks/main.yml", ROLE), "utf8");
const installationTasks = readFileSync(new URL("tasks/installation.yml", ROLE), "utf8");

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function render(template: string, vars: Record<string, string>): string {
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

const installations = [
  { user: "outdoor", project: "outdoor", port: "7332", tag: "github:Tojins/sandbar#v0.39.7" },
  { user: "sandbar", project: "sandbar", port: "7333", tag: "github:Tojins/sandbar#v0.40.0" },
] as const;

function varsFor(row: (typeof installations)[number]): Record<string, string> {
  const home = `/home/${row.user}`;
  return {
    sandbar_project: row.project,
    sandbar_checkout: `${home}/${row.project}`,
    sandbar_installation_dir: `${home}/installation`,
    sandbar_installation_driver_tag: row.tag,
    sandbar_reader_port: row.port,
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
      `/usr/bin/node /home/${row.user}/installation/install-driver.mjs ${row.tag}`,
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

  it("renders the same driver's reader on its inventory port", () => {
    const unit = render(uiTemplate, vars);
    expect(unit).not.toMatch(/\{\{|\}\}/);
    expect(values(unit, "PartOf")).toEqual(["sandbar.service"]);
    expect(values(unit, "After")).toEqual(["sandbar.service"]);
    expect(values(unit, "ExecStartPre")).toEqual([]);
    expect(values(unit, "ExecStart")).toEqual([
      `/usr/bin/node /home/${row.user}/installation/driver/node_modules/sandbar/dist/cli.js ui --port ${row.port}`,
    ]);
    expect(values(unit, "Restart")).toEqual(["no"]);
  });
});

describe("multi-installation role orchestration", () => {
  it("loops only the user-scoped task group", () => {
    expect(mainTasks).toMatch(
      /- name: Configure each sandbar installation[\s\S]*?ansible\.builtin\.include_tasks: installation\.yml[\s\S]*?loop: "\{\{ sandbar_installations \}\}"/,
    );
    for (const task of ["packages.yml", "podman-global.yml", "apparmor.yml", "swap.yml", "ssh.yml", "upgrades.yml", "caddy.yml"]) {
      expect(mainTasks).toContain(`ansible.builtin.import_tasks: ${task}`);
    }
  });

  it("clones, optionally copies config, names missing files, and excludes workDir", () => {
    expect(installationTasks).toContain('repo: "{{ sandbar_installation.clone_url }}"');
    expect(installationTasks).toContain('when: sandbar_installation.config_src is defined');
    expect(installationTasks).toContain("- sandbar.config.mjs\n    - sandbar.env");
    expect(installationTasks).toContain("Missing {{ item.stat.path }}");
    expect(installationTasks).toContain('path: "{{ sandbar_checkout }}/.git/info/exclude"');
    expect(installationTasks).toContain('line: "/{{ sandbar_work_dir }}/"');
  });

  it("leaves Caddy on the first reader until prefix routing lands", () => {
    expect(render(caddyTemplate, {
      sandbar_ui_http_port: "80",
      sandbar_caddy_reader_port: "7332",
    })).toBe(":80 {\n\treverse_proxy 127.0.0.1:7332\n}\n");
  });
});
