import { readFileSync } from "node:fs";

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

describe("sandbar.config.example.mjs", () => {
  it("keeps required fields active and every optional field discoverable", async () => {
    const configSource = readFileSync(new URL("config.ts", import.meta.url), "utf8");
    const exampleUrl = new URL("../sandbar.config.example.mjs", import.meta.url);
    const exampleSource = readFileSync(exampleUrl, "utf8");
    const fields = runConfigFields(configSource);
    const documentedFields = new Set(
      [...exampleSource.matchAll(/^\s*\/\/\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(
        (match) => match[1],
      ),
    );
    const example = (
      (await import(exampleUrl.href)) as { readonly default: RunConfig }
    ).default;

    expect(
      fields.required.filter((field) => !Object.hasOwn(example, field)),
    ).toEqual([]);
    expect(
      fields.optional.filter((field) => !documentedFields.has(field)),
    ).toEqual([]);
    expect(() => resolveConfig(example)).not.toThrow();
  });

  it("is included in the published package manifest", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly files: readonly string[] };

    expect(packageJson.files).toContain("sandbar.config.example.mjs");
  });
});
