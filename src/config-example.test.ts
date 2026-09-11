import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveConfig, type RunConfig } from "./config.js";

type RunConfigFields = {
  readonly required: readonly string[];
  readonly optional: readonly string[];
};

function runConfigFields(source: string): RunConfigFields {
  const sourceFile = ts.createSourceFile(
    "config.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "RunConfig",
  );
  if (declaration === undefined || !ts.isTypeLiteralNode(declaration.type)) {
    throw new Error("config.ts must declare RunConfig as an object type");
  }

  const required: string[] = [];
  const optional: string[] = [];
  for (const member of declaration.type.members) {
    if (!ts.isPropertySignature(member)) continue;
    if (!ts.isIdentifier(member.name)) {
      throw new Error("RunConfig fields must use identifier names");
    }
    (member.questionToken === undefined ? required : optional).push(
      member.name.text,
    );
  }
  return { required, optional };
}

function routingEnvKey(field: string): string {
  return `SANDBAR_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

describe("sandbar.config.example.mjs", () => {
  it("keeps required fields active and every optional field discoverable", async () => {
    const configSource = readFileSync(new URL("config.ts", import.meta.url), "utf8");
    const exampleUrl = new URL("../sandbar.config.example.mjs", import.meta.url);
    const envExampleUrl = new URL("../sandbar.env.example", import.meta.url);
    const exampleSource = readFileSync(exampleUrl, "utf8");
    const envExampleSource = readFileSync(envExampleUrl, "utf8");
    const fields = runConfigFields(configSource);
    const documentedFields = new Set(
      [...exampleSource.matchAll(/^\s*\/\/\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(
        (match) => match[1],
      ),
    );
    // Execute the published idiom with its paired env template without reading
    // or creating the developer's real, gitignored sandbar.env. Keeping the
    // fixture under this package also exercises the package-root import exactly
    // as a copied config uses it.
    const fixtureParent = fileURLToPath(new URL("../.sandbar/", import.meta.url));
    await mkdir(fixtureParent, { recursive: true });
    const fixtureDir = await mkdtemp(join(fixtureParent, "config-example-"));
    const fixtureConfig = join(fixtureDir, "sandbar.config.mjs");
    await copyFile(exampleUrl, fixtureConfig);
    await writeFile(
      join(fixtureDir, "sandbar.env"),
      `${envExampleSource}\n` +
        "GH_TOKEN=fixture-token\n" +
        "SANDBAR_IMPLEMENTER_AGENT=codex\n" +
        "SANDBAR_IMPLEMENTER_MODEL_ID=gpt-5.6-sol\n" +
        "SANDBAR_IMPLEMENTER_EFFORT=high\n",
    );
    let example: RunConfig;
    try {
      example = (
        (await import(pathToFileURL(fixtureConfig).href)) as {
          readonly default: RunConfig;
        }
      ).default;
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }

    expect(
      fields.required.filter((field) => !Object.hasOwn(example, field)),
    ).toEqual([]);
    expect(
      fields.optional.filter(
        (field) =>
          !Object.hasOwn(example, field) &&
          !documentedFields.has(field) &&
          !envExampleSource.includes(`# ${routingEnvKey(field)}=`),
      ),
    ).toEqual([]);
    expect(example.env).toMatchObject({ GH_TOKEN: "fixture-token" });
    expect(example.env).not.toHaveProperty("SANDBAR_IMPLEMENTER_AGENT");
    expect(example).toMatchObject({
      implementerAgent: "codex",
      implementerModelId: "gpt-5.6-sol",
      implementerEffort: "high",
    });
    expect(() => resolveConfig(example)).not.toThrow();
    // The default 5s is a measurement of the box, not of this contract: the
    // case imports the BUILT package root through the example's own idiom,
    // under whatever load the other 87 files are putting on the machine, and
    // timed out at 5s in one gate run while passing in 1.7s on an idle one.
  }, 30_000);

  it("ships both files that make up the published example", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly files: readonly string[] };

    expect(packageJson.files).toContain("sandbar.config.example.mjs");
    expect(packageJson.files).toContain("sandbar.env.example");
  });
});
