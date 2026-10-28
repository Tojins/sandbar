// Prompt-template loader.
//
// Every agent prompt's prose lives as a markdown file in the repo-root
// `prompts/` directory, NOT as string literals scattered through `lines.push`
// calls. This module is the only thing that reads those files; the prompt
// assemblers (`prompt.ts`, `resolve-loop.ts`, `reflect.ts`) load their
// templates into module-level constants at import time (I/O at the boundary)
// and then render them with `render()`, which is a pure string substitution
// — so the assembly functions themselves stay pure and table-testable.
//
// Division of labour: substantive instructional prose belongs in the markdown
// templates. Structural scaffolding — section headings, code-fence wrapping,
// interpolating diffs/traces, deciding which optional block to include — stays
// in TS, which fills the templates' `{{placeholders}}` with the result.
//
// `prompts/` sits beside `src/` and `dist/` (one level up from this file in
// both the source tree and the compiled tree), so the same relative resolution
// works whether running tests against `src/` or the built package from `dist/`.
// It is shipped via the `files` array in package.json.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/**
 * Read a prompt template by name (without the `.md` extension). Trailing
 * whitespace is trimmed so composed layers join cleanly. Throws if the file is
 * missing — a missing template is a packaging bug, not a runtime condition.
 */
export function loadTemplate(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8").trimEnd();
}

/**
 * Every template file, by file name, as written. `npm run reflect` (#182)
 * hands its synthesizer the prompts of the running build to propose edits to.
 */
export function readPromptFiles(): ReadonlyMap<string, string> {
  return new Map(readdirSync(PROMPTS_DIR).filter((name) => name.endsWith(".md")).sort()
    .map((name) => [name, readFileSync(join(PROMPTS_DIR, name), "utf8")]));
}

/**
 * Substitute `{{key}}` placeholders in `template` with values from `vars`.
 * Throws on a placeholder with no matching value — that means the template and
 * its call site have drifted apart, which we want to fail loudly in tests.
 */
export function render(template: string, vars: Record<string, string> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new Error(`prompt template: no value supplied for {{${key}}}`);
    }
    return value;
  });
}
