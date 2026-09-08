// The systemd user units and Caddyfile deploy/ansible installs (#140/#138),
// table-tested as the strings a host receives. The templates are Jinja only
// in that they carry `{{ name }}` placeholders — no filters, loops or
// conditionals — which lets this suite render them with a substitution and
// assert the deployment contracts directly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROLE = new URL("../deploy/ansible/roles/sandbar/", import.meta.url);
const DAEMON_TEMPLATE = readFileSync(
  new URL("templates/sandbar.service.j2", ROLE),
  "utf8",
);
const UI_TEMPLATE = readFileSync(
  new URL("templates/sandbar-ui.service.j2", ROLE),
  "utf8",
);
const CADDY_TEMPLATE = readFileSync(new URL("templates/Caddyfile.j2", ROLE), "utf8");
const MAIN_TASKS = readFileSync(new URL("tasks/main.yml", ROLE), "utf8");
const DEFAULTS = readFileSync(new URL("defaults/main.yml", ROLE), "utf8");

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function render(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`unrendered placeholder ${name}`);
    return value;
  });
}

const VARS = {
  sandbar_checkout: "/home/sandbar/outdoor",
  sandbar_launch_command: "/usr/bin/npm run sandbar",
  sandbar_stop_timeout_sec: "900",
};

function expectPlainDocumentedPlaceholders(
  template: string,
  vars: Record<string, string>,
): void {
  const braces = template.match(/\{\{[^}]*\}\}/g) ?? [];
  const names = braces.map((b) => {
    const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(b);
    expect(m, `not a plain placeholder: ${b}`).not.toBeNull();
    return m![1]!;
  });
  expect(new Set(names)).toEqual(new Set(Object.keys(vars)));
  for (const name of names) {
    expect(DEFAULTS, `${name} missing from defaults/main.yml`).toMatch(
      new RegExp(`^${name}:`, "m"),
    );
  }
  expect(template).not.toMatch(/\{%/);
}

function directives(unit: string): string[] {
  return unit
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function values(unit: string, key: string): string[] {
  return directives(unit)
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

describe("deploy/ansible sandbar.service template", () => {
  it("uses only plain placeholders, each a documented role default", () => {
    expectPlainDocumentedPlaceholders(DAEMON_TEMPLATE, VARS);
  });

  it("renders a unit with the recorded decisions", () => {
    const unit = render(DAEMON_TEMPLATE, VARS);
    expect(unit).not.toMatch(/\{\{|\}\}/);

    // No retry loop: exits 2 and 4 are deliberate stops.
    expect(values(unit, "Restart")).toEqual(["no"]);
    expect(directives(unit).filter((l) => /^Restart(Sec|Force)/.test(l))).toEqual([]);

    // The credential file is in the host process environment.
    expect(values(unit, "EnvironmentFile")).toEqual(["/home/sandbar/outdoor/sandbar.env"]);
    expect(values(unit, "WorkingDirectory")).toEqual(["/home/sandbar/outdoor"]);

    // Refresh the checkout, install what it names, then launch — in that order.
    expect(values(unit, "ExecStartPre")).toEqual([
      "/usr/bin/git pull --ff-only",
      "/usr/bin/npm ci --no-audit",
    ]);
    expect(values(unit, "ExecStart")).toEqual(["/usr/bin/npm run sandbar"]);
    const order = directives(unit).filter((l) => /^Exec/.test(l));
    expect(order.map((l) => l.split("=")[0])).toEqual([
      "ExecStartPre",
      "ExecStartPre",
      "ExecStart",
    ]);

    // A user unit that starts at boot under linger, after the podman socket.
    expect(values(unit, "WantedBy")).toEqual(["default.target"]);
    expect(values(unit, "Requires")).toEqual(["podman.socket"]);
    expect(values(unit, "After")).toEqual(["podman.socket"]);

    // A stop is sandbar's own cleanup, given time.
    expect(values(unit, "KillMode")).toEqual(["mixed"]);
    expect(values(unit, "TimeoutStopSec")).toEqual(["900"]);
  });

  it("carries no timer, no log sweep and no memory limit", () => {
    const unit = render(DAEMON_TEMPLATE, VARS);
    for (const key of ["OnCalendar", "RuntimeMaxSec", "MemoryMax", "MemoryHigh", "ExecStopPost"]) {
      expect(values(unit, key)).toEqual([]);
    }
  });
});

describe("deploy/ansible standalone UI templates", () => {
  const uiVars = {
    sandbar_checkout: "/home/sandbar/outdoor",
    sandbar_service_name: "sandbar",
    sandbar_ui_command: "/usr/bin/npx sandbar ui --port 7332",
  };
  const caddyVars = {
    sandbar_ui_http_port: "80",
    sandbar_ui_port: "7332",
  };

  it("uses only plain placeholders, each a documented role default", () => {
    expectPlainDocumentedPlaceholders(UI_TEMPLATE, uiVars);
    expectPlainDocumentedPlaceholders(CADDY_TEMPLATE, caddyVars);
  });

  it("keeps the reader behind and part of the daemon without sharing its install step", () => {
    const unit = render(UI_TEMPLATE, uiVars);
    expect(unit).not.toMatch(/\{\{|\}\}/);
    expect(values(unit, "PartOf")).toEqual(["sandbar.service"]);
    expect(values(unit, "After")).toEqual(["sandbar.service"]);
    expect(values(unit, "WorkingDirectory")).toEqual(["/home/sandbar/outdoor"]);
    expect(values(unit, "ExecStart")).toEqual(["/usr/bin/npx sandbar ui --port 7332"]);
    expect(values(unit, "ExecStartPre")).toEqual([]);
    expect(values(unit, "Restart")).toEqual(["no"]);
    expect(values(unit, "WantedBy")).toEqual(["default.target"]);
  });

  it("proxies the public HTTP port to the standalone loopback port", () => {
    expect(render(CADDY_TEMPLATE, caddyVars)).toBe(
      ":80 {\n\treverse_proxy 127.0.0.1:7332\n}\n",
    );
  });

  it("skips the whole UI task file when sandbar_ui_port is zero", () => {
    expect(MAIN_TASKS).toMatch(
      /ansible\.builtin\.import_tasks: ui\.yml\n  when: sandbar_ui_port > 0/,
    );
  });
});
