// What a branch's own gate stack file may change about its gate (#186).
//
// The gate is the grader. The stack DEFINITION — containers, env, mounts,
// steps — comes from the source branch, while the images built from the
// branch's Containerfiles are part of the work under test. A branch that could
// edit its grader could widen its own mounts or privileges, or weaken a check
// until it passes. The one exception is container `env`: an env value widens
// nothing, and outdoor#576 needed exactly that (`TZ` on its database) — except
// on a container that holds a `secretEnv` credential (#241), where an env
// value can redirect it, so an env edit there is non-env.
//
// So a branch's stack file is classified against the source tip's, over
// RESOLVED stacks, so key order and a spelled-out default are not changes:
//
//   - `same` — nothing the gate reads differs;
//   - `env-only` — the container names and order, every container field but
//     `env`, and the steps are all equal. Adding, removing or changing an env
//     key all count as env;
//   - `non-env` — anything else, and a branch stack file that is missing or
//     does not validate. Differences name fields, never values.
//
// The stack in effect is the tip's, with the branch's `env` laid over it only
// when the change is env-only. It is built FROM THE TIP rather than taken from
// the branch, so nothing but `env` can cross from the branch even where the
// two would be equal. The overlay is validated again (its env must not
// collide with `config.env`, #166); a collision is a non-env difference.
//
// Nothing here reads git: stack-source.ts reads both files and calls
// `stackInEffect`. What a non-env change does to the issue — gate-1 runs once
// on the tip's stack and the issue parks with NEEDS-STACK-CHANGE — is the
// state machine's and finalize's.

import { canonicalSha256 } from "./canonical-json.js";
import {
  type ResolvedGateStack,
  type ResolvedStack,
  sandboxGateAttachmentsOf,
} from "./config.js";
import { SandbarError } from "./errors.js";

// One thing a branch changed that is not container env: `where` is the
// container, the step, the list or the file; `what` is the field or the event.
export type StackDifference = {
  readonly where: string;
  readonly what: string;
};

// A non-env change, as the park reports it: the file and what differs in it.
export type StackChange = {
  readonly path: string;
  readonly differences: readonly StackDifference[];
};

export type StackClassification =
  | { readonly kind: "same" }
  | { readonly kind: "env-only"; readonly containers: readonly string[] }
  | ({ readonly kind: "non-env" } & StackChange);

// What reading the branch's stack file yielded. `invalid` carries the
// validation message, which names where the text was read from.
export type BranchStackRead =
  | { readonly kind: "ok"; readonly stack: ResolvedGateStack }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string };

// The stack a gate runs for one head, and how the branch's file got it there.
export type StackInEffect = ResolvedStack & {
  readonly classification: StackClassification;
};

const nonEnv = (path: string, what: string): StackClassification => ({
  kind: "non-env",
  path,
  differences: [{ where: path, what }],
});

// The park report of a classification: null unless the branch changed the
// stack beyond env.
export const stackChangeOf = (c: StackClassification): StackChange | null =>
  c.kind === "non-env" ? { path: c.path, differences: c.differences } : null;

const equal = (a: unknown, b: unknown): boolean =>
  canonicalSha256(a) === canonicalSha256(b);

type Named = { readonly name: string };

// Added, removed and reordered members of a named list, then every field of a
// member both sides have, except `name` and whatever `skip` lists. Fields are
// enumerated from the values rather than a list here, so a field the resolved
// shape gains later is compared without anyone remembering to add it.
function listDifferences(
  list: string,
  label: (name: string) => string,
  tip: readonly Named[],
  branch: readonly Named[],
  skip: ReadonlySet<string>,
): StackDifference[] {
  const tipNames = tip.map((m) => m.name);
  const branchNames = branch.map((m) => m.name);
  const differences: StackDifference[] = [
    ...branchNames
      .filter((n) => !tipNames.includes(n))
      .map((n) => ({ where: list, what: `'${n}' added` })),
    ...tipNames
      .filter((n) => !branchNames.includes(n))
      .map((n) => ({ where: list, what: `'${n}' removed` })),
  ];
  const common = tipNames.filter((n) => branchNames.includes(n));
  if (!equal(common, branchNames.filter((n) => tipNames.includes(n)))) {
    differences.push({ where: list, what: "order" });
  }
  const branchByName = new Map(branch.map((m) => [m.name, m]));
  for (const t of tip) {
    const b = branchByName.get(t.name);
    // Reported as removed above.
    if (b === undefined) continue;
    const tipFields = new Map<string, unknown>(Object.entries(t));
    const branchFields = new Map<string, unknown>(Object.entries(b));
    for (const field of new Set([...tipFields.keys(), ...branchFields.keys()])) {
      if (field === "name" || skip.has(field)) continue;
      if (
        tipFields.has(field) !== branchFields.has(field) ||
        !equal(tipFields.get(field), branchFields.get(field))
      ) {
        differences.push({ where: label(t.name), what: field });
      }
    }
  }
  return differences;
}

export function classifyStackChange(
  path: string,
  tip: ResolvedGateStack,
  branch: BranchStackRead,
): StackClassification {
  if (branch.kind === "missing") {
    return nonEnv(path, "missing");
  }
  if (branch.kind === "invalid") {
    return nonEnv(path, `does not validate: ${branch.message}`);
  }
  const differences = [
    ...listDifferences(
      "containers",
      (n) => `container '${n}'`,
      tip.containers,
      branch.stack.containers,
      new Set(["env"]),
    ),
    ...listDifferences(
      "steps",
      (n) => `step '${n}'`,
      tip.steps,
      branch.stack.steps,
      new Set(),
    ),
    // Laid over a container that holds a secret, a branch's env (an upstream
    // URL, a proxy variable) could send that secret somewhere (#241).
    ...tip.containers
      .filter((c, i) =>
        c.secretEnv.length > 0 &&
        branch.stack.containers[i]?.name === c.name &&
        !equal(c.env, branch.stack.containers[i]?.env))
      .map((c) => ({ where: `container '${c.name}'`, what: "env (holds secretEnv)" })),
  ];
  if (differences.length > 0) return { kind: "non-env", path, differences };
  const containers = tip.containers
    .filter((c, i) => !equal(c.env, branch.stack.containers[i]?.env))
    .map((c) => c.name);
  return containers.length === 0 ? { kind: "same" } : { kind: "env-only", containers };
}

// The tip's stack with each container's `env` taken from the branch's
// container of the same name. Every other field stays the tip's.
export function overlayBranchEnv(
  tip: ResolvedGateStack,
  branch: ResolvedGateStack,
): ResolvedGateStack {
  return {
    ...tip,
    containers: tip.containers.map((c) => ({
      ...c,
      env: branch.containers.find((b) => b.name === c.name)?.env ?? c.env,
    })),
  };
}

export function stackInEffect(
  path: string,
  tip: ResolvedStack,
  branch: BranchStackRead,
  configEnv: Readonly<Record<string, string>>,
): StackInEffect {
  const classification = classifyStackChange(path, tip.stack, branch);
  if (classification.kind !== "env-only" || branch.kind !== "ok") {
    return { ...tip, classification };
  }
  const stack = overlayBranchEnv(tip.stack, branch.stack);
  try {
    return {
      stack,
      attachments: sandboxGateAttachmentsOf(stack, configEnv, path),
      classification,
    };
  } catch (err) {
    if (!(err instanceof SandbarError)) throw err;
    return {
      ...tip,
      classification: nonEnv(path, `does not validate: ${err.message}`),
    };
  }
}

// One bullet per difference, for every comment that reports a park.
export function renderStackDifferences(
  differences: readonly StackDifference[],
): string {
  return differences.map((d) => `- ${d.where}: ${d.what}`).join("\n");
}
