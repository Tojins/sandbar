// Read a value from the sandbar env file, falling back to process.env.
//
// Sandboxes are launched by @ai-hero/sandcastle, which reads its env file
// itself. The orchestrator process running on the host does not get those
// values automatically, so the pre-flight check needs to read the same file.

import { readFileSync } from "node:fs";

export type EnvReader = (key: string) => string | undefined;

export function makeEnvReader(envFilePath: string): EnvReader {
  return (key: string): string | undefined => {
    let raw: string;
    try {
      raw = readFileSync(envFilePath, "utf8");
    } catch {
      return process.env[key];
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      if (t.slice(0, eq).trim() !== key) continue;
      let v = t.slice(eq + 1).trim();
      if (
        v.length >= 2 &&
        ((v[0] === '"' && v[v.length - 1] === '"') ||
          (v[0] === "'" && v[v.length - 1] === "'"))
      ) {
        v = v.slice(1, -1);
      }
      return v || process.env[key];
    }
    return process.env[key];
  };
}
