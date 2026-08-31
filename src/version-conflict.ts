// The one merge conflict in this repo whose answer is not a judgement call
// (#68), resolved mechanically before the resolve agent is ever invoked.
//
// AGENTS.md requires every commit to move `version` in `package.json`, and the
// command that does it rewrites the two matching entries in
// `package-lock.json` as well. So any two branches landing in the same cycle
// have both bumped `version` from the same base, and their merge conflicts in
// those two files BY CONSTRUCTION — not occasionally, but every time a cycle
// lands more than one issue. Handing that to the resolve loop spends part of a
// bounded, expensive agentic budget re-deriving the same answer every cycle,
// and the agent can get it wrong: neither side's value is correct, and the
// correct one — `max(ours, theirs)` bumped once — appears on neither branch.
//
// ---------------------------------------------------------------------------
// What this module will and will not touch
// ---------------------------------------------------------------------------
//
// It is deliberately the narrowest thing that closes the collision: a file
// qualifies only when EVERY conflict hunk in it is a lone `"version": "x.y.z"`
// line AND the two sides of the file, reconstructed whole, differ at nothing
// but the version fields npm itself mirrors. Anything else in those files — a
// dependency, a script, the lock's package graph — is a real conflict, and it
// goes to the agent with the file untouched. The decision is PER FILE: a
// version-only `package.json` beside a genuinely conflicted `package-lock.json`
// resolves the first and leaves the second alone, which is safe because the
// merger's existing `npm install` step re-derives the lock from the merged
// `package.json` afterwards. This module never makes the lockfile consistent
// and must not try to.
//
// TWO CHECKS, not one, because either alone is unsound:
//
//   * The HUNK check ("every conflicted line is a version line") is what makes
//     the textual rewrite well defined — it is the only reason we can write a
//     resolved file that preserves the formatting npm produced.
//   * The JSON check ("the two sides differ only at the allowed paths") is
//     what keeps a DEPENDENCY's version out of it. `package-lock.json` holds
//     hundreds of `"version": "1.2.3"` lines at the same indentation as the
//     root package's own, so the hunk check alone would happily renumber
//     esbuild to the repo's version. The two sides are reconstructed from the
//     conflicted worktree file rather than from git's stages, so everything
//     git already merged cleanly is common to both and the diff is exactly the
//     set of hunks.
//
// ROOT FILES ONLY. The "two mirrors" claim — `version` and
// `packages[""].version` — is a fact about the lockfile of the package at the
// repo root; a workspace member's version lives under its own `packages/<dir>`
// key and is not what npm writes there. A host with workspaces gets the
// unchanged agentic path, which is the correct answer rather than a guess.
//
// The value is `max(ours, theirs) + 1` patch, computed ONCE across every file
// that qualifies, so `package.json` and `package-lock.json` cannot come out of
// the same merge disagreeing. Greater than both parents, so the merge commit's
// tree carries a version nobody else has used — which is the rule AGENTS.md is
// stating, and neither side's own value satisfies it.
//
// Pure: the merger's adapter reads the files, writes them back and stages
// them. `merger.ts` owns the log line, and `prompts/resolve-conflict.md` states
// the same `max + 1` rule for the agent, which still sees this conflict
// whenever a file here declines.

// Repo-relative paths this module will consider, and the JSON paths inside each
// that a conflict may legitimately be confined to.
const ALLOWED_VERSION_PATHS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  "package.json": [["version"]],
  "package-lock.json": [["version"], ["packages", "", "version"]],
};

export function isVersionConflictFile(path: string): boolean {
  return Object.hasOwn(ALLOWED_VERSION_PATHS, path);
}

// A `"version": "x.y.z"` line and nothing else: exactly what npm writes, and
// exactly what the rewrite below can reproduce. Anything laid out differently
// declines rather than being reformatted — a merger that reflows a host's
// package.json is a merger nobody can predict.
const VERSION_LINE = /^([ \t]*)"version": "(\d+\.\d+\.\d+)"(,?)$/;

const CONFLICT_START = /^<{7}(?:\s|$)/;
const CONFLICT_BASE = /^\|{7}(?:\s|$)/;
const CONFLICT_SEP = /^={7}$/;
const CONFLICT_END = /^>{7}(?:\s|$)/;

export type ConflictSegment =
  | { readonly kind: "text"; readonly lines: readonly string[] }
  | {
      readonly kind: "conflict";
      readonly ours: readonly string[];
      readonly theirs: readonly string[];
    };

// A conflicted file split into what git merged and what it could not. Answers
// null on anything it does not fully understand — an unterminated hunk, a
// nested one, a separator with no start. Declining to parse is the only safe
// failure: this module's whole licence is that it knows exactly what it is
// rewriting.
export function parseConflictSegments(text: string): ConflictSegment[] | null {
  const lines = text.split("\n");
  const segments: ConflictSegment[] = [];
  let plain: string[] = [];
  let i = 0;
  const flush = (): void => {
    if (plain.length > 0) {
      segments.push({ kind: "text", lines: plain });
      plain = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    if (CONFLICT_SEP.test(line) || CONFLICT_END.test(line) || CONFLICT_BASE.test(line)) {
      return null; // a closing marker with no hunk open
    }
    if (!CONFLICT_START.test(line)) {
      plain.push(line);
      i++;
      continue;
    }
    flush();
    i++;
    const ours: string[] = [];
    const theirs: string[] = [];
    // `ours` runs to the first `|||||||` (diff3/zdiff3) or `=======`.
    let sawSep = false;
    for (; i < lines.length; i++) {
      const l = lines[i] as string;
      if (CONFLICT_START.test(l)) return null; // nested
      if (CONFLICT_BASE.test(l) || CONFLICT_SEP.test(l)) {
        sawSep = CONFLICT_SEP.test(l);
        i++;
        break;
      }
      if (CONFLICT_END.test(l)) return null;
      ours.push(l);
    }
    // A diff3 base section, dropped: it is context for a human, never part of
    // the result.
    if (!sawSep) {
      for (; i < lines.length; i++) {
        const l = lines[i] as string;
        if (CONFLICT_SEP.test(l)) {
          sawSep = true;
          i++;
          break;
        }
        if (CONFLICT_START.test(l) || CONFLICT_END.test(l)) return null;
      }
    }
    if (!sawSep) return null;
    let closed = false;
    for (; i < lines.length; i++) {
      const l = lines[i] as string;
      if (CONFLICT_END.test(l)) {
        closed = true;
        i++;
        break;
      }
      if (CONFLICT_START.test(l) || CONFLICT_SEP.test(l) || CONFLICT_BASE.test(l)) {
        return null;
      }
      theirs.push(l);
    }
    if (!closed) return null;
    segments.push({ kind: "conflict", ours, theirs });
  }
  flush();
  return segments;
}

// One line of the resolved file: either text git already agreed on, or the
// version slot whose value is only known once every qualifying file has been
// read.
export type VersionResolutionPart =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "version"; readonly indent: string; readonly comma: string };

export type VersionFilePlan = {
  readonly path: string;
  // Every version value either side offered, so the caller can take one max
  // across all the files at once.
  readonly versions: readonly string[];
  readonly parts: readonly VersionResolutionPart[];
};

export type VersionFileAnalysis =
  | { readonly kind: "resolvable"; readonly plan: VersionFilePlan }
  | { readonly kind: "declined"; readonly reason: string };

export function analyzeVersionConflict(
  path: string,
  text: string,
): VersionFileAnalysis {
  const allowed = ALLOWED_VERSION_PATHS[path];
  if (!allowed) return { kind: "declined", reason: "not a version-bearing file" };

  const segments = parseConflictSegments(text);
  if (!segments) {
    return { kind: "declined", reason: "conflict markers could not be parsed" };
  }
  if (!segments.some((s) => s.kind === "conflict")) {
    return { kind: "declined", reason: "no conflict hunks found in the file" };
  }

  const parts: VersionResolutionPart[] = [];
  const versions: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "text") {
      for (const line of seg.lines) parts.push({ kind: "literal", text: line });
      continue;
    }
    const ours = matchVersionLine(seg.ours);
    const theirs = matchVersionLine(seg.theirs);
    if (!ours || !theirs) {
      return {
        kind: "declined",
        reason: "a conflict hunk is not a lone `version` line",
      };
    }
    if (ours.version === theirs.version) {
      // Not a version collision at all; something else made git stop here.
      return { kind: "declined", reason: "a hunk offers the same version on both sides" };
    }
    versions.push(ours.version, theirs.version);
    parts.push({ kind: "version", indent: ours.indent, comma: ours.comma });
  }

  // The semantic half. Both sides are the merged file with one choice made at
  // every hunk, so they differ at exactly the hunks — and a hunk at a
  // dependency's `version` shows up here as a path nobody allowed.
  const oursJson = parseJson(sideText(segments, "ours"));
  const theirsJson = parseJson(sideText(segments, "theirs"));
  if (!oursJson.ok || !theirsJson.ok) {
    return {
      kind: "declined",
      reason: "a side of the conflict is not valid JSON on its own",
    };
  }
  const stray = differingPaths(oursJson.value, theirsJson.value).filter(
    (p) => !allowed.some((a) => samePath(a, p)),
  );
  if (stray.length > 0) {
    return {
      kind: "declined",
      reason: `the conflict also touches ${stray.map(renderJsonPath).join(", ")}`,
    };
  }

  return { kind: "resolvable", plan: { path, versions, parts } };
}

function matchVersionLine(
  lines: readonly string[],
): { readonly indent: string; readonly version: string; readonly comma: string } | null {
  if (lines.length !== 1) return null;
  const m = VERSION_LINE.exec(lines[0] as string);
  if (!m) return null;
  return { indent: m[1] as string, version: m[2] as string, comma: m[3] as string };
}

function sideText(segments: readonly ConflictSegment[], side: "ours" | "theirs"): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "text") out.push(...seg.lines);
    else out.push(...(side === "ours" ? seg.ours : seg.theirs));
  }
  return out.join("\n");
}

type Json = unknown;

function parseJson(text: string): { ok: true; value: Json } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch {
    return { ok: false };
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Every JSON path at which the two documents disagree. Recursion stops at the
// first divergence on a branch: "these two objects differ" is reported as the
// deepest path that is still common, which is what the decline message needs
// to name.
export function differingPaths(
  a: Json,
  b: Json,
  prefix: readonly string[] = [],
): (readonly string[])[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: (readonly string[])[] = [];
    for (const k of [...keys].sort()) {
      if (!Object.hasOwn(a, k) || !Object.hasOwn(b, k)) {
        out.push([...prefix, k]);
        continue;
      }
      out.push(...differingPaths(a[k], b[k], [...prefix, k]));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const out: (readonly string[])[] = [];
    for (let i = 0; i < a.length; i++) {
      out.push(...differingPaths(a[i], b[i], [...prefix, String(i)]));
    }
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

// `packages[""].version` — the empty key is the root package, and a bare dotted
// join would render it as a trailing dot nobody could read.
const renderJsonPath = (p: readonly string[]): string =>
  p.length === 0 ? "the document root" : p.map((s) => (s === "" ? '""' : s)).join(".");

// `max(ours, theirs)` bumped once. Null when any value is not a plain
// `major.minor.patch` — a prerelease or a build tag is a release decision, not
// a collision, and this module declines rather than inventing an ordering.
export function bumpAboveAll(versions: readonly string[]): string | null {
  if (versions.length === 0) return null;
  let best: [number, number, number] | null = null;
  for (const v of versions) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) return null;
    const parts: [number, number, number] = [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ];
    if (best === null || compareTriple(parts, best) > 0) best = parts;
  }
  if (best === null) return null;
  return `${best[0]}.${best[1]}.${best[2] + 1}`;
}

function compareTriple(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

export function renderVersionResolution(
  plan: VersionFilePlan,
  version: string,
): string {
  return plan.parts
    .map((p) =>
      p.kind === "literal"
        ? p.text
        : `${p.indent}"version": "${version}"${p.comma}`,
    )
    .join("\n");
}

// What the merger does with a conflicted merge, decided in one place from the
// files it read. `resolved` empty ⇒ nothing mechanical to do and the whole
// conflict is the agent's, exactly as before this existed — and `version` is
// then null, because there is no value to claim was written anywhere.
// `declined` is still carried in that case: a version file this module looked
// at and would not touch is the single most useful line in the merger log when
// someone asks why an attempt was spent.
export type VersionCollisionPlan = {
  readonly version: string | null;
  readonly resolved: readonly VersionFilePlan[];
  readonly declined: readonly { readonly path: string; readonly reason: string }[];
};

// `files` is every conflicted path the merger read, with its worktree text —
// null for one it could not read (a modify/delete conflict has no file to
// parse). Paths this module does not own are ignored entirely and are not
// reported as declined: they were never candidates.
export function planVersionCollision(
  files: readonly { readonly path: string; readonly text: string | null }[],
): VersionCollisionPlan | null {
  const resolved: VersionFilePlan[] = [];
  const declined: { path: string; reason: string }[] = [];
  for (const f of files) {
    if (!isVersionConflictFile(f.path)) continue;
    if (f.text === null) {
      declined.push({ path: f.path, reason: "the file could not be read" });
      continue;
    }
    const a = analyzeVersionConflict(f.path, f.text);
    if (a.kind === "resolvable") resolved.push(a.plan);
    else declined.push({ path: f.path, reason: a.reason });
  }
  if (resolved.length === 0 && declined.length === 0) return null;
  // One max across every qualifying file, so package.json and its lockfile
  // cannot leave the same merge disagreeing about what version this is.
  //
  // Null is unreachable with a non-empty `resolved` — the hunk check only
  // admits a plain `major.minor.patch` — and is handled anyway as the same
  // decline every other unrecognised shape gets, rather than by asserting.
  const version = bumpAboveAll(resolved.flatMap((p) => p.versions));
  if (version === null) {
    return {
      version: null,
      resolved: [],
      declined: [
        ...declined,
        ...resolved.map((p) => ({
          path: p.path,
          reason: "the conflicting versions are not plain `major.minor.patch`",
        })),
      ],
    };
  }
  return { version, resolved, declined };
}
