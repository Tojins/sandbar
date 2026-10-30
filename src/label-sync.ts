// `sandbar labels sync` (#245): make the host repo's labels match a declared
// set, idempotently.
//
// Every label sandbar reads or writes has to exist in the host repo, and the
// run never creates one (#8): a missing label still fails loud at finalize
// time. This command is the explicit, by-hand (or deploy-run) way to create
// them, so names, descriptions and colours stop drifting between hosts.
//
// The declared set has two sources (`declaredLabels`):
//   - PROTOCOL labels come from here, so they cannot drift from the code that
//     reads them: `1-human-spec`, `1-human-later`, `2-agent-build`,
//     `2-agent-later`, the configured handoff label (`2-human-unstick`),
//     `3-human-review`, `auto-land` and `land`, each with a canonical
//     description and colour. Each workflow label is named by its stage and
//     who acts next, and carries a built-in rename from its old name.
//   - `config.labelSync` adds HOST labels (name, description and colour all
//     required), overrides a protocol label's description or colour, and
//     declares renames (`from`).
//
// `planLabelSync` is the pure diff against `gh label list`; nothing is
// written until the whole plan holds. A label that is missing is created and
// one whose description or colour differs is updated, both with `gh label
// create --force`; one that matches is left alone, so a second run changes
// nothing. A rename edits `from` into `name` (`gh label edit --name`), which
// keeps it on every issue that carries it; when both already exist the sync
// refuses before writing anything, because merging them is a human's call.
// Nothing is ever deleted: a repo label outside the set is reported as
// undeclared and kept. Names match case-insensitively, as GitHub does.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { LAND_LABEL, HUMAN_REVIEW_LABEL } from "./chunks.js";
import { DEFAULT_LABELS, type LabelConfig, type LabelDeclaration } from "./config.js";
import { HUMAN_SPEC_LABEL } from "./deploy-watch.js";
import { SandbarError } from "./errors.js";
import { AGENT_BUILD_LABEL } from "./finalize.js";
import { AUTO_LAND_LABEL } from "./lanes.js";
import { AGENT_LATER_LABEL, HUMAN_LATER_LABEL } from "./plan-resolver.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

// A listing this long may have been cut off, and a label beyond it would be
// planned as a create on every run.
const LIST_LIMIT = 1000;

export type SyncedLabel = {
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly from: string | null;
};

export type RepoLabel = {
  readonly name: string;
  readonly description: string;
  readonly color: string;
};

export type LabelSyncStep =
  | { readonly kind: "create"; readonly label: SyncedLabel }
  | {
      readonly kind: "update";
      readonly label: SyncedLabel;
      readonly changed: readonly ("description" | "color")[];
    }
  // `from` is the repo's spelling of the label being renamed.
  | { readonly kind: "rename"; readonly label: SyncedLabel; readonly from: string };

export type LabelSyncPlan = {
  readonly steps: readonly LabelSyncStep[];
  readonly undeclared: readonly string[];
};

const key = (name: string): string => name.toLowerCase();

// Each label's `from` is the name it had before the labels were named by stage
// and next actor, so one sync moves a repo's issues across. The handoff label
// renames only under its default name; a host that configured its own keeps it.
function protocolLabels(labels: LabelConfig): readonly SyncedLabel[] {
  return [
    {
      name: HUMAN_SPEC_LABEL,
      description: "A human finishes the spec before an agent can take it",
      color: "1d76db",
      from: "ready-for-human",
    },
    {
      name: HUMAN_LATER_LABEL,
      description: "Not a priority now; a human decides when it moves on",
      color: "d4c5f9",
      from: "waiting",
    },
    {
      name: AGENT_BUILD_LABEL,
      description: "Queued for sandbar: its agent loop works this issue",
      color: "0e8a16",
      from: "ready-for-agent",
    },
    {
      name: AGENT_LATER_LABEL,
      description: "For sandbar once a human moves it to 2-agent-build",
      color: "c2e0c6",
      from: "agent-queued",
    },
    {
      name: labels.handoff,
      description: "Sandbar stopped; its comment says what a human does next",
      color: "d93f0b",
      from: labels.handoff === DEFAULT_LABELS.handoff ? "needs-human" : null,
    },
    {
      name: HUMAN_REVIEW_LABEL,
      description: "Sandbar's work is on a review chunk branch awaiting a human",
      color: "c5def5",
      from: "needs-review",
    },
    {
      name: AUTO_LAND_LABEL,
      description: "Sandbar lands this issue on a green gate, without a review chunk",
      color: "5319e7",
      from: null,
    },
    {
      name: LAND_LABEL,
      description: "On a sandbar chunk pull request: land the chunk",
      color: "1d76db",
      from: null,
    },
  ];
}

// The protocol labels with `config.labelSync` applied over them, then the
// host's own. Each name and each rename source may appear once.
export function declaredLabels(
  labels: LabelConfig,
  declarations: readonly LabelDeclaration[],
): readonly SyncedLabel[] {
  const byName = new Map<string, LabelDeclaration>();
  for (const declaration of declarations) {
    if (byName.has(key(declaration.name))) {
      throw new SandbarError(`config.labelSync declares \`${declaration.name}\` twice.`);
    }
    byName.set(key(declaration.name), declaration);
  }
  const protocol = protocolLabels(labels);
  const protocolNames = new Set(protocol.map((label) => key(label.name)));
  const merged: readonly SyncedLabel[] = [
    ...protocol.map((label) => {
      const declaration = byName.get(key(label.name));
      return {
        name: label.name,
        description: declaration?.description ?? label.description,
        color: declaration?.color ?? label.color,
        from: declaration?.from ?? label.from,
      };
    }),
    ...declarations
      .filter((declaration) => !protocolNames.has(key(declaration.name)))
      .map(({ name, description, color, from }) => {
        if (description === undefined || color === undefined) {
          throw new SandbarError(
            `config.labelSync: \`${name}\` is not a sandbar protocol label, so it needs ` +
              "both a description and a color.",
          );
        }
        return { name, description, color, from: from ?? null };
      }),
  ];
  const seen = new Set<string>();
  for (const name of merged.flatMap((label) => label.from === null ? [label.name] : [label.name, label.from])) {
    if (seen.has(key(name))) {
      throw new SandbarError(
        `config.labelSync names \`${name}\` both as a label and as a rename's \`from\`, ` +
          "or as the `from` of two renames.",
      );
    }
    seen.add(key(name));
  }
  return merged;
}

export function planLabelSync(
  declared: readonly SyncedLabel[],
  repo: readonly RepoLabel[],
): LabelSyncPlan {
  const inRepo = new Map(repo.map((label) => [key(label.name), label]));
  const steps = declared.flatMap((label): LabelSyncStep[] => {
    const current = inRepo.get(key(label.name));
    const old = label.from === null ? undefined : inRepo.get(key(label.from));
    if (current === undefined) {
      return [old === undefined ? { kind: "create", label } : { kind: "rename", label, from: old.name }];
    }
    if (old !== undefined) {
      throw new SandbarError(
        `The repo has both \`${old.name}\` and \`${current.name}\`, so the declared rename ` +
          "cannot run; nothing was changed. Move the issues across and delete " +
          `\`${old.name}\` by hand, or drop the rename from config.labelSync.`,
      );
    }
    const changed = [
      ...(current.description === label.description ? [] : ["description" as const]),
      ...(key(current.color) === label.color ? [] : ["color" as const]),
    ];
    return changed.length === 0 ? [] : [{ kind: "update", label, changed }];
  });
  const accounted = new Set([
    ...declared.map((label) => key(label.name)),
    ...steps.flatMap((step) => (step.kind === "rename" ? [key(step.from)] : [])),
  ]);
  return {
    steps,
    undeclared: repo.filter((label) => !accounted.has(key(label.name))).map((label) => label.name),
  };
}

export function labelSyncCommand(step: LabelSyncStep, repoFlag: string): readonly string[] {
  const { name, description, color } = step.label;
  const fields = ["--description", description, "--color", color];
  return step.kind === "rename"
    ? ["label", "edit", step.from, "--repo", repoFlag, "--name", name, ...fields]
    : ["label", "create", name, "--repo", repoFlag, "--force", ...fields];
}

export function renderLabelSync(plan: LabelSyncPlan): readonly string[] {
  return [
    ...(plan.steps.length === 0 ? ["labels: nothing to change"] : []),
    ...plan.steps.map((step) => {
      switch (step.kind) {
        case "create":
          return `created ${step.label.name}`;
        case "update":
          return `updated ${step.label.name} (${step.changed.join(", ")})`;
        case "rename":
          return `renamed ${step.from} -> ${step.label.name}`;
      }
    }),
    ...plan.undeclared.map((name) => `undeclared, kept: ${name}`),
  ];
}

function isRepoLabel(value: unknown): value is RepoLabel {
  return typeof value === "object" && value !== null &&
    "name" in value && typeof value.name === "string" &&
    "description" in value && typeof value.description === "string" &&
    "color" in value && typeof value.color === "string";
}

// The listing, the plan, then every step at once: the steps touch distinct
// labels, and a rerun after a failed one finishes the rest.
export async function syncLabels(args: {
  readonly repo: RepoRef;
  readonly cwd: string;
  readonly declared: readonly SyncedLabel[];
}): Promise<LabelSyncPlan> {
  const repoFlag = repoSlug(args.repo);
  const { stdout } = await exec("gh", [
    "label", "list", "--repo", repoFlag, "--limit", String(LIST_LIMIT),
    "--json", "name,description,color",
  ], { cwd: args.cwd });
  const listed: unknown = JSON.parse(stdout);
  if (!Array.isArray(listed) || !listed.every(isRepoLabel)) {
    throw new SandbarError(`gh label list answered ${JSON.stringify(stdout)}`);
  }
  if (listed.length >= LIST_LIMIT) {
    throw new SandbarError(
      `${repoFlag} has at least ${LIST_LIMIT} labels, more than one listing shows; nothing was changed.`,
    );
  }
  const plan = planLabelSync(args.declared, listed);
  await Promise.all(
    plan.steps.map((step) => exec("gh", labelSyncCommand(step, repoFlag), { cwd: args.cwd })),
  );
  return plan;
}
