// The systemd user unit deploy/ansible installs (#140), table-tested as the
// string a host receives. The template is Jinja only in that it carries
// `{{ name }}` placeholders — no filters, loops or conditionals — which is
// what lets this suite render it with a substitution and assert the
// decisions the issue recorded: no retry loop, the credential file in the
// environment, refresh-then-install before the launch.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROLE = new URL("../deploy/ansible/roles/sandbar/", import.meta.url);
const TEMPLATE = readFileSync(new URL("templates/sandbar.service.j2", ROLE), "utf8");
const DEFAULTS = readFileSync(new URL("defaults/main.yml", ROLE), "utf8");

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function render(vars: Record<string, string>): string {
  return TEMPLATE.replace(PLACEHOLDER, (_m, name: string) => {
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
    const braces = TEMPLATE.match(/\{\{[^}]*\}\}/g) ?? [];
    const names = braces.map((b) => {
      const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(b);
      expect(m, `not a plain placeholder: ${b}`).not.toBeNull();
      return m![1]!;
    });
    expect(new Set(names)).toEqual(new Set(Object.keys(VARS)));
    for (const name of names) {
      expect(DEFAULTS, `${name} missing from defaults/main.yml`).toMatch(
        new RegExp(`^${name}:`, "m"),
      );
    }
    expect(TEMPLATE).not.toMatch(/\{%/);
  });

  it("renders a unit with the recorded decisions", () => {
    const unit = render(VARS);
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
    const unit = render(VARS);
    for (const key of ["OnCalendar", "RuntimeMaxSec", "MemoryMax", "MemoryHigh", "ExecStopPost"]) {
      expect(values(unit, key)).toEqual([]);
    }
  });
});
