// Which test files a gate runs (#259, #266, #267): parts 1–6 of the spec, over
// a stack's declaration (config.ts), a diff and the scenario writers' picks.
// Parts 1–5 are the floor every gate runs.
//
//   1. the global `sanity` set;
//   2. `core.sanity`, when a changed file matches `core.paths`. A core file
//      reaches nothing else: no domain, even one whose paths cover it, and not
//      the `related` pass;
//   3. the `sanity` of every domain whose `paths` a changed file matches, and
//      of every domain named by hand (`sandbar gate --domains`);
//   4. what the `related` pass prints for the changed files that are still
//      there and are not core's. It runs inside the stack (gate-stack.ts), so
//      `planSelection` stops before it and `finishSelection` takes its output;
//   5. the changed files some step's `tests` match: the branch's own tests,
//      for this gate only;
//   6. the scenario writer's pick (#267, scenario-writer-run.ts): the
//      `sanity` of each domain it named and the test files it named, each
//      with its one-line reason. Gate-1 adds its issue's once the writer is
//      done, gate-2 the stored pick of every issue in the land unit, and
//      `sandbar gate` none.
//
// Resolved at gate time against the gated tree: a sanity glob that matches no
// file there, or a domain named by hand or picked that the stack does not
// declare, is ignored and recorded, never an error; so is a picked test file
// the tree does not have. So is a selected file that no step's
// `tests` match, since nothing would run it. Each step's `{tests}` becomes the
// selected files its `tests` match, and a step left with none is skipped.
//
// A branch that edits the declaration (stack-change.ts's `domains`) is
// planned under the tip's declaration and its own, and parts 1–3 are their
// union, so a sanity set only grows until the edit lands; the steps and the
// `related` pass stay the stack in effect's.
//
// Globs are matched against repository paths: `*` and `?` stay inside one
// directory, `**` spans any number of them (`**/` none at all), and a glob led
// by `!` excludes what it matches from the list it is in.
//
// `readSelectionTree` is the one adapter: the gated tree's files and its diff
// against the fork from a base ref, working tree included, so `sandbar gate`
// over uncommitted work selects for it. `selectionPlanFor` is what every gate
// asks first, and for a stack whose steps declare no `tests` it reads nothing.
//
// A pick outlives the run that made it, since its issue may land in a later
// one: `writeGatePick` keeps each issue's latest as
// `<stateDir>/gate-picks/<issue>.json` (an admission with no pick removes it), and `readGatePicks` is gate-2's read.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ResolvedGateStack,
  type ResolvedGateStep,
  type SanityDeclaration,
} from "./config.js";
import { isErrno } from "./errors.js";
import { gitStdout } from "./git-ops.js";
import { gatePickErrors } from "./scenario-parser.js";
import type { StackInEffect } from "./stack-change.js";

export type ChangedFile = {
  readonly path: string;
  readonly deleted: boolean;
};

// Part 6 for one issue: what its scenario writer named, and why.
export type GatePick = {
  readonly domains: readonly { readonly name: string; readonly reason: string }[];
  readonly tests: readonly { readonly path: string; readonly reason: string }[];
};

export type IssuePick = GatePick & { readonly issue: number };

// What a gate left out, and why. `set` names where a glob was declared:
// `sanity`, `core`, `domain '<name>'`, or `issue #<n>` for the test files
// that issue's writer picked.
export type SelectionIgnored =
  | { readonly kind: "glob"; readonly set: string; readonly glob: string }
  | { readonly kind: "domain"; readonly name: string }
  | { readonly kind: "unstepped"; readonly file: string };

// Parts 1–3, 5 and 6, and what part 4 is to be asked. A picked domain's set
// is in `domains`; `picked` is the picked test files the tree has, and
// `picks` what was picked, reasons and all.
export type SelectionPlan = {
  readonly global: readonly string[];
  readonly core: readonly string[];
  readonly domains: Readonly<Record<string, readonly string[]>>;
  readonly changed: readonly string[];
  readonly picks: readonly IssuePick[];
  readonly picked: readonly string[];
  readonly relatedInput: readonly string[];
  readonly ignored: readonly SelectionIgnored[];
  // The gated tree's files, which a `related` path has to be one of.
  readonly tree: ReadonlySet<string>;
};

// A gate's whole selection. `files` is what ran; `steps` maps each step that
// declares `tests` to its expansion, empty for a skipped one.
export type GateSelection = Omit<SelectionPlan, "relatedInput" | "tree"> & {
  readonly related: readonly string[];
  readonly files: readonly string[];
  readonly steps: Readonly<Record<string, readonly string[]>>;
};

const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g;

function globRegExp(glob: string): RegExp {
  const source = glob.replace(GLOB_TOKEN, (token) =>
    token === "**/" ? "(?:.*/)?"
    : token === "**" ? ".*"
    : token === "*" ? "[^/]*"
    : token === "?" ? "[^/]"
    : `\\${token}`);
  return new RegExp(`^${source}$`);
}

type Globs = {
  readonly include: readonly { readonly glob: string; readonly re: RegExp }[];
  readonly exclude: readonly RegExp[];
};

function parseGlobs(globs: readonly string[]): Globs {
  return {
    include: globs.filter((g) => !g.startsWith("!")).map((glob) => ({ glob, re: globRegExp(glob) })),
    exclude: globs.filter((g) => g.startsWith("!")).map((g) => globRegExp(g.slice(1))),
  };
}

export function globMatcher(globs: readonly string[]): (path: string) => boolean {
  const { include, exclude } = parseGlobs(globs);
  return (path) => include.some(({ re }) => re.test(path)) && !exclude.some((re) => re.test(path));
}

const sortedUnion = (...lists: readonly (readonly string[])[]): string[] =>
  [...new Set(lists.flat())].sort();

export function planSelection(args: {
  // The stack in effect's first; a branch's own edit after it.
  readonly declarations: readonly [SanityDeclaration, ...SanityDeclaration[]];
  readonly steps: readonly ResolvedGateStep[];
  readonly changed: readonly ChangedFile[];
  readonly files: readonly string[];
  readonly namedDomains: readonly string[];
  readonly picks: readonly IssuePick[];
}): SelectionPlan {
  const { declarations, changed, files, picks } = args;
  const namedDomains = [
    ...args.namedDomains,
    ...picks.flatMap((pick) => pick.domains.map((domain) => domain.name)),
  ];
  const ignored = new Map<string, SelectionIgnored>();
  const ignore = (entry: SelectionIgnored) => ignored.set(JSON.stringify(entry), entry);
  const sanityFiles = (set: string, globs: readonly string[]): string[] => {
    const { include, exclude } = parseGlobs(globs);
    return include.flatMap(({ glob, re }) => {
      const matched = files.filter((f) => re.test(f) && !exclude.some((x) => x.test(f)));
      if (matched.length === 0) ignore({ kind: "glob", set, glob });
      return matched;
    });
  };
  const isCoreUnder = (d: SanityDeclaration) =>
    d.core === null ? () => false : globMatcher(d.core.paths);

  let global: string[] = [];
  let core: string[] = [];
  const domains: Record<string, string[]> = {};
  for (const d of declarations) {
    global = sortedUnion(global, sanityFiles("sanity", d.sanity));
    const isCore = isCoreUnder(d);
    if (d.core !== null && changed.some((c) => isCore(c.path))) {
      core = sortedUnion(core, sanityFiles("core", d.core.sanity));
    }
    const touched = changed.filter((c) => !isCore(c.path));
    for (const domain of d.domains) {
      const inDomain = globMatcher(domain.paths);
      if (!namedDomains.includes(domain.name) && !touched.some((c) => inDomain(c.path))) continue;
      domains[domain.name] = sortedUnion(
        domains[domain.name] ?? [],
        sanityFiles(`domain '${domain.name}'`, domain.sanity),
      );
    }
  }
  for (const name of namedDomains) {
    if (!declarations.some((d) => d.domains.some((domain) => domain.name === name))) {
      ignore({ kind: "domain", name });
    }
  }

  const present = changed.filter((c) => !c.deleted).map((c) => c.path);
  // Step by step, so one step's exclusions do not hide another's files.
  const stepMatchers = args.steps.flatMap((s) => (s.tests === null ? [] : [globMatcher(s.tests)]));
  const isCoreInEffect = isCoreUnder(declarations[0]);
  return {
    global,
    core,
    domains,
    changed: present.filter((path) => stepMatchers.some((matches) => matches(path))),
    picks,
    // A picked path holds no glob character (scenario-parser.ts), so as a
    // glob it matches itself alone.
    picked: sortedUnion(...picks.map((pick) =>
      sanityFiles(`issue #${pick.issue}`, pick.tests.map((test) => test.path)))),
    relatedInput: present.filter((path) => !isCoreInEffect(path)),
    ignored: [...ignored.values()],
    tree: new Set(files),
  };
}

// The `related` pass's stdout as test files, or the printed paths that are
// not files of the gated tree, which make the pass red.
export function parseRelatedOutput(
  stdout: string,
  tree: ReadonlySet<string>,
): { readonly files: readonly string[] } | { readonly missing: readonly string[] } {
  const printed = sortedUnion(stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  const missing = printed.filter((path) => !tree.has(path));
  return missing.length > 0 ? { missing } : { files: printed };
}

export function finishSelection(
  plan: SelectionPlan,
  related: readonly string[],
  steps: readonly ResolvedGateStep[],
): GateSelection {
  const { relatedInput: _input, tree: _tree, ...parts } = plan;
  const selected = sortedUnion(
    plan.global, plan.core, ...Object.values(plan.domains), plan.changed, plan.picked, related,
  );
  const stepFiles = Object.fromEntries(steps.flatMap((step) =>
    step.tests === null ? [] : [[step.name, selected.filter(globMatcher(step.tests))]]));
  const ran = new Set(Object.values(stepFiles).flat());
  return {
    ...parts,
    related,
    files: selected.filter((file) => ran.has(file)),
    steps: stepFiles,
    ignored: [
      ...plan.ignored,
      ...selected.filter((file) => !ran.has(file)).map((file) => ({ kind: "unstepped" as const, file })),
    ],
  };
}

// What a red gate's trace leads with: the test files the gate ran (#266).
export function selectionTraceLine(selection: GateSelection | undefined): string {
  if (selection === undefined) return "";
  return selection.files.length === 0
    ? "[sandbar] this gate's selection held no test file.\n\n"
    : `[sandbar] this gate ran these test files:\n${selection.files.join("\n")}\n\n`;
}

// `command` with each `token` entry replaced by `values`, one entry each.
export function expandToken(
  command: readonly string[],
  token: string,
  values: readonly string[],
): string[] {
  return command.flatMap((arg) => (arg === token ? values : [arg]));
}

// The tree at `worktree` and what changed in it since its fork from `baseRef`:
// tracked and untracked files, less what the working tree deleted.
export async function readSelectionTree(
  worktree: string,
  baseRef: string,
): Promise<{ readonly changed: readonly ChangedFile[]; readonly files: readonly string[] }> {
  const fork = (await gitStdout(worktree, ["merge-base", baseRef, "HEAD"])).trim();
  const [diff, cached, untracked] = (await Promise.all([
    gitStdout(worktree, ["diff", "--name-status", "--no-renames", "-z", fork]),
    gitStdout(worktree, ["ls-files", "-z", "--cached"]),
    gitStdout(worktree, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ])).map((out) => out.split("\0").filter((field) => field !== "")) as [string[], string[], string[]];
  const changed = new Map<string, ChangedFile>();
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const path = diff[i + 1] as string;
    changed.set(path, { path, deleted: diff[i] === "D" });
  }
  for (const path of untracked) changed.set(path, { path, deleted: false });
  const files = sortedUnion(cached, untracked).filter((f) => changed.get(f)?.deleted !== true);
  return { changed: [...changed.values()], files };
}

// The plan for one gate of the stack in effect over the tree at `worktree`,
// diffed against its fork from `baseRef`, or null when no step selects.
export async function selectionPlanFor(
  inEffect: Pick<StackInEffect, "stack" | "classification">,
  worktree: string,
  baseRef: string,
  added: { readonly namedDomains?: readonly string[]; readonly picks?: readonly IssuePick[] } = {},
): Promise<SelectionPlan | null> {
  const { stack, classification } = inEffect;
  if (!selects(stack)) return null;
  return planSelection({
    declarations: classification.kind === "domains" ? [stack, classification.branch] : [stack],
    steps: stack.steps,
    ...(await readSelectionTree(worktree, baseRef)),
    namedDomains: added.namedDomains ?? [],
    picks: added.picks ?? [],
  });
}

export const selects = (stack: ResolvedGateStack): boolean =>
  stack.steps.some((step) => step.tests !== null);

const gatePickPath = (dir: string, issue: number): string => join(dir, `${issue}.json`);

// Replaces the issue's stored pick; no pick removes the earlier admission's.
export async function writeGatePick(dir: string, issue: number, pick: GatePick | null): Promise<void> {
  const path = gatePickPath(dir, issue);
  if (pick === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dir, { recursive: true });
  const incoming = `${path}.tmp-${process.pid}`;
  await writeFile(incoming, JSON.stringify(pick));
  await rename(incoming, path);
}

// The stored pick of each of `issues` that has one.
export async function readGatePicks(
  dir: string,
  issues: readonly number[],
): Promise<readonly IssuePick[]> {
  const read = async (issue: number): Promise<IssuePick[]> => {
    const path = gatePickPath(dir, issue);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
    const value: unknown = JSON.parse(text);
    const errors = gatePickErrors(value);
    if (errors.length > 0) throw new Error(`${path}: ${errors.join("; ")}`);
    return [{ issue, ...(value as GatePick) }];
  };
  return (await Promise.all(issues.map(read))).flat();
}
