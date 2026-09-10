// The outdoor daemon's installation-owned config (#149). Nothing in the
// consumer repository needs to know that sandbar exists.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile, splitRoleRouting } from "sandbar";

const cwd = "/home/outdoor/outdoor";
const image = "localhost/outdoor:dev";
const { routing, env: credentials } = splitRoleRouting(
  readEnvFile(new URL("sandbar.env", import.meta.url)),
);
const usesCodex = Object.entries(routing).some(
  ([field, provider]) => field.endsWith("Agent") && provider === "codex",
);

export default {
  cwd,
  ghOwner: "Tojins",
  ghRepo: "outdoor",
  developers: ["Tojins"],
  requiresSandbar: "0.41.14",
  botName: "sandbar",
  botEmail: "demanthomas+sandbar@gmail.com",
  uiPort: 7331,
  sandboxImage: image,
  gateStack: JSON.parse(readFileSync(join(cwd, "gate/stack.json"), "utf8")),
  copyToWorktree: [
    {
      from: fileURLToPath(new URL("files/settings.local.json", import.meta.url)),
      to: ".claude/settings.local.json",
    },
  ],
  images: [
    {
      tag: image,
      containerfile: "Containerfile.dev",
      rebuildOn: ["Containerfile.dev"],
    },
  ],
  env: {
    ...credentials,
    ...(usesCodex
      ? { CODEX_AUTH_JSON: readFileSync(join(homedir(), ".codex/auth.json"), "utf8") }
      : {}),
  },
  ...routing,
};
