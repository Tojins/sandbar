import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function optionalRunConfigFields(source: string): string[] {
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

  return declaration.type.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || member.questionToken === undefined) {
      return [];
    }
    if (!ts.isIdentifier(member.name)) {
      throw new Error("RunConfig optional fields must use identifier names");
    }
    return [member.name.text];
  });
}

describe("sandbar.config.example.mjs", () => {
  it("keeps every optional RunConfig field discoverable", () => {
    const configSource = readFileSync(new URL("config.ts", import.meta.url), "utf8");
    const exampleSource = readFileSync(
      new URL("../sandbar.config.example.mjs", import.meta.url),
      "utf8",
    );
    const documentedFields = new Set(
      [...exampleSource.matchAll(/^\s*\/\/\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(
        (match) => match[1],
      ),
    );

    expect(
      optionalRunConfigFields(configSource).filter(
        (field) => !documentedFields.has(field),
      ),
    ).toEqual([]);
  });
});
