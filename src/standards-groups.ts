// Rule groups: how a standards file is split for the quality pass (#204).
//
// THE PROTOCOL. A standards file — the built-in `prompts/coding-standards.md`
// and the consumer's `promptExtensions.reviewerQuality` — is split by its `##`
// headings into rule groups:
//
// - A heading is an ATX line `## <name>` (an optional closing run of `#` is
//   dropped) outside a ``` or ~~~ fence. `#`, `###` and deeper lines are body,
//   so a group keeps its own sub-structure. CRLF reads as LF.
// - A heading may end in a flag list, `## Tests {janitor}`, split on commas
//   and whitespace. `janitor` exposes the group to the idle janitor (#205);
//   any other flag is a warning and is dropped, which fails safe. Sandbar
//   assumes nothing about whether a flagged group's fixes are safe: that is
//   the consumer's call, and the built-in group is never janitor material.
// - `## Leave alone` (any case) is reserved: what no group may raise. Its body
//   goes to every group, several such sections are concatenated, and a flag on
//   one is a warning.
// - Text before the first `##` is a preamble shared by every group; above 600
//   chars it is a warning, because rules belong under a group.
// - A group with an empty body is dropped with a warning. Ids are the name's
//   slug, the later of two equal slugs taking `-2`, `-3`…; the built-in
//   group's id is `sandbar`, and a project slug never takes it.
// - A file with no `##` other than Leave alone is one group, `project`.
// - More than 5 groups in total (built-in included) is a warning: each group
//   costs one lister's fixed overhead plus a read of the diff.
// Parse problems are never errors.
//
// The built-in file is exactly one group plus Leave alone (a test pins it).
//
// THE GRADER COMES FROM THE SOURCE TIP. `readQualityStandards` reads a `{ path }`
// extension from the bare cache's `origin/<sourceBranch>` as last fetched, the
// rule stack-source.ts applies to the gate stack (#186): a branch that edits
// its standards file is graded by the landed version, never by its own. An
// absent file means built-in only; a directory at the path is an error that
// says so (`readFileAtRef`). The implementer keeps its `@path` into its
// own worktree (prompt.ts); this module is the quality roles' copy.

import type { PromptExtension } from "./config.js";
import type { EventInput } from "./events.js";
import { readFileAtRef } from "./git-ops.js";
import { loadTemplate } from "./prompts.js";

export type RuleGroup = {
  // "sandbar" for the built-in group, otherwise the name's slug, deduplicated.
  readonly id: string;
  // The heading text, flags and closing `#`s stripped.
  readonly name: string;
  readonly origin: "sandbar" | "project";
  // Verbatim, without the heading line.
  readonly body: string;
  readonly janitor: boolean;
};

export type ParsedStandards = {
  readonly preamble: string;
  readonly groups: readonly RuleGroup[];
  // Leave alone bodies, in file order.
  readonly leaveAlone: readonly string[];
  readonly warnings: readonly string[];
};

export type QualityStandards = {
  // The built-in group first, then the project's in file order.
  readonly groups: readonly RuleGroup[];
  // The project preamble; "" when there is none.
  readonly preamble: string;
  // The built-in Leave alone, then the project's.
  readonly leaveAlone: readonly string[];
  readonly warnings: readonly string[];
};

// What one rendering is for: one group's lister, or every group at once.
export type QualityLens =
  | { readonly kind: "group"; readonly group: RuleGroup }
  | { readonly kind: "all" };

const HEADING = /^## +(.*?)(?: +#+)? *$/;
const FLAGS = /\s*\{([^}]*)\}$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LEAVE_ALONE = "leave alone";
const MAX_GROUPS = 5;
const MAX_PREAMBLE_CHARS = 600;

type Section = { readonly heading: string; readonly lines: string[] };

// A section's text without its leading blank lines or trailing whitespace.
const sectionBody = (lines: readonly string[]): string =>
  lines.join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();

const slug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";

// The preamble's lines and every `##` section, fences respected.
function splitSections(text: string): { readonly preamble: string[]; readonly sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  let fence: string | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker !== undefined) {
        fence = marker;
      } else {
        const heading = HEADING.exec(line)?.[1];
        if (heading !== undefined) {
          sections.push({ heading, lines: [] });
          continue;
        }
      }
    } else if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker
    ) {
      fence = null;
    }
    (sections.at(-1)?.lines ?? preamble).push(line);
  }
  return { preamble, sections };
}

export function parseStandards(text: string, origin: RuleGroup["origin"]): ParsedStandards {
  const { preamble: preambleLines, sections } = splitSections(text);
  const warnings: string[] = [];
  const leaveAlone: string[] = [];
  const named: { readonly name: string; readonly body: string; readonly janitor: boolean }[] = [];
  for (const { heading, lines } of sections) {
    const flagList = FLAGS.exec(heading);
    const name = (flagList === null ? heading : heading.slice(0, flagList.index)).trim();
    const flags = (flagList?.[1] ?? "").split(/[\s,]+/).filter((flag) => flag !== "");
    const body = sectionBody(lines);
    if (name.toLowerCase() === LEAVE_ALONE) {
      if (flags.length > 0) {
        warnings.push(`flags {${flags.join(", ")}} on "## ${name}" are ignored: Leave alone goes to every group.`);
      }
      if (body !== "") leaveAlone.push(body);
      continue;
    }
    for (const flag of flags.filter((f) => f !== "janitor")) {
      warnings.push(`unknown flag {${flag}} on "## ${name}" is ignored; the only flag is {janitor}.`);
    }
    if (body === "") {
      warnings.push(`"## ${name}" has no rules and is dropped.`);
      continue;
    }
    named.push({ name, body, janitor: flags.includes("janitor") });
  }

  const preamble = sectionBody(preambleLines);
  if (named.length === 0) {
    // Today's single block of rules, whatever its shape.
    const groups: RuleGroup[] = preamble === ""
      ? []
      : [{ id: origin, name: "Project standards", origin, body: preamble, janitor: false }];
    return { preamble: "", groups, leaveAlone, warnings };
  }
  if (preamble.length > MAX_PREAMBLE_CHARS) {
    warnings.push(
      `the text before the first "##" is ${preamble.length} chars (over ${MAX_PREAMBLE_CHARS}): ` +
        `rules belong under a "##" group.`,
    );
  }

  // A project id never takes the built-in group's.
  const used = new Set<string>(origin === "project" ? ["sandbar"] : []);
  const groups = named.map(({ name, body, janitor }): RuleGroup => {
    const base = origin === "sandbar" ? "sandbar" : slug(name);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return { id, name, origin, body, janitor };
  });
  return { preamble, groups, leaveAlone, warnings };
}

export function combineStandards(
  builtin: ParsedStandards,
  project: ParsedStandards | null,
): QualityStandards {
  const groups = [...builtin.groups, ...(project?.groups ?? [])];
  return {
    groups,
    preamble: project?.preamble ?? "",
    leaveAlone: [...builtin.leaveAlone, ...(project?.leaveAlone ?? [])],
    warnings: [
      ...builtin.warnings,
      ...(project?.warnings ?? []),
      ...(groups.length > MAX_GROUPS
        ? [
            `${groups.length} rule groups (over ${MAX_GROUPS}): each one costs a quality ` +
              "lister's fixed overhead plus a read of the diff.",
          ]
        : []),
    ],
  };
}

// The preamble, the lens's groups under their own `##` headings, then every
// Leave alone body. Flags are not rendered.
export function renderStandards(s: QualityStandards, lens: QualityLens): string {
  const groups = lens.kind === "all" ? s.groups : [lens.group];
  return [
    s.preamble,
    ...groups.map((group) => `## ${group.name}\n\n${group.body}`),
    s.leaveAlone.length === 0 ? "" : `## Leave alone\n\n${s.leaveAlone.join("\n\n")}`,
  ].filter((part) => part !== "").join("\n\n");
}

// The groups the consumer exposed to the janitor (#205), rendered as one set;
// null when none is flagged.
export function janitorStandards(
  s: QualityStandards,
): { readonly groups: readonly RuleGroup[]; readonly text: string } | null {
  const groups = s.groups.filter((group) => group.janitor && group.origin === "project");
  return groups.length === 0 ? null : { groups, text: renderStandards({ ...s, groups }, { kind: "all" }) };
}

const BUILTIN = parseStandards(loadTemplate("coding-standards"), "sandbar");

// Warnings already raised, keyed by where the text came from and the text
// itself (a blob's content is its oid), so each version complains once.
const warned = new Set<string>();

// The standards the quality roles grade by, read at the source tip.
export async function readQualityStandards(src: {
  readonly repoDir: string;
  readonly sourceBranch: string;
  readonly extension: PromptExtension | undefined;
  readonly onEvent: (event: EventInput) => Promise<void> | void;
}): Promise<QualityStandards> {
  const { extension } = src;
  if (extension === undefined) return combineStandards(BUILTIN, null);
  const [label, text] = "text" in extension
    ? ["promptExtensions.reviewerQuality", extension.text]
    : [
        `${extension.path} at origin/${src.sourceBranch}`,
        await readFileAtRef(src.repoDir, `refs/remotes/origin/${src.sourceBranch}`, extension.path),
      ];
  if (text === null) return combineStandards(BUILTIN, null);
  const standards = combineStandards(BUILTIN, parseStandards(text, "project"));
  const key = `${label}\0${text}`;
  if (standards.warnings.length > 0 && !warned.has(key)) {
    warned.add(key);
    await src.onEvent({
      kind: "complaint",
      severity: "warning",
      message: `Quality standards: ${label}:\n${standards.warnings.map((w) => `- ${w}`).join("\n")}`,
    });
  }
  return standards;
}
