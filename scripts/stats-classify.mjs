#!/usr/bin/env node
// The measurement step of #183 (#209): sort the quality pass's findings and
// the fixer's commits from #194's JSON into classes, so the structural checks
// are chosen from counts. Report-only: nothing imports it, it writes nothing,
// and it is not shipped. Run it from a checkout:
//
//   node dist/stats-cli.js --json --with-prose --logs <dir> > report.json
//   node scripts/stats-classify.mjs report.json [--repo <dir>]
//
// A finding is one top-level item (a list item, or a paragraph) under the
// lister's `### Tests` or `### Standards` heading, read from the speech of a
// `quality-list` invocation whose verdict was CHANGES-REQUESTED. Verify
// reports are not read: they restate every finding still open, so they would
// count one finding once per fix round. A report whose log is gone has no
// speech, and is counted as such.
//
// A finding's class is the first of FINDING_CLASSES whose pattern matches its
// text, else `unclassified`, and every unclassified finding is listed for a
// human to sort. Its tokens are apportioned by finding count: each finding
// carries an equal share of its lister invocation's tokens, and of the fixer
// tokens of the same run, issue and attempt. A token total is every bucket the
// invocation reported, reasoning being part of output, and `-` where none of
// the shares was measured.
//
// A fixer commit is classed by the paths it touches, read from `--repo`
// (default `.`): `version only` when it touches nothing but package.json and
// package-lock.json, `tests only` when the rest are all test files, `mixed`
// otherwise. The version files are left out of the test check because the
// ritual bumps the version in every commit. A sha the repo does not have is
// `missing`; a commit that touches nothing is `empty`.
//
// A report without prose or shas (stats run without `--with-prose`, or by a
// build older than #209) and a bad flag exit 2.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const FINDING_CLASSES = [
  ["deletion/uncovered", /\buncovered\b|\bnot (?:covered|exercised|tested|asserted|pinned)\b|\bno test\b|\buntested\b|\bwithout (?:a |any )?tests?\b|\bmissing tests?\b|\bdelet(?:e|ed|ing|ion)\b.*\b(?:green|passes|passing|changes nothing)\b|\bstays? green\b|\b(?:asserts|tests) nothing\b/i],
  ["version", /\bversion bump\b|\bbump(?:s|ed|ing)? (?:the )?version\b|\bnpm version\b|\bpackage(?:-lock)?\.json\b.*\bversion\b|\bversion\b.*\bpackage(?:-lock)?\.json\b/i],
  ["size", /\bfile[- ]size\b|\b(?:over|exceeds?|past|cross(?:es)?|above) \d{3,} lines\b|\b\d{3,}[- ]line file\b|\bfile is (?:too )?(?:long|large)\b/i],
  ["rule:complexity", /\bcomplexity that doesn['’]t pay\b|\bdoesn['’]t pay for itself\b/i],
  ["rule:spaghetti", /\bspaghetti\b/i],
  ["rule:wrong-abstraction", /\bwrong abstraction\b/i],
  ["rule:wrong-layer", /\bwrong layer\b/i],
  ["rule:loose-contracts", /\bloose contracts?\b/i],
  ["rule:non-atomic", /\bnon-atomic\b/i],
  ["rule:module-header", /\bmodule header\b|\bheader comment\b/i],
];

export const COMMIT_CLASSES = ["tests only", "version only", "mixed", "empty", "missing"];

const VERSION_FILES = new Set(["package.json", "package-lock.json"]);
const TEST_PATH = /(?:^|\/)(?:__tests__|__fixtures__|fixtures|tests?)\/|\.(?:test|spec)(?:-util)?\.[cm]?[jt]sx?$/;

export const classifyFinding = (text) =>
  FINDING_CLASSES.find(([, pattern]) => pattern.test(text))?.[0] ?? "unclassified";

// `paths` is null for a sha the repo does not have.
export function classifyCommit(paths) {
  if (paths === null) return "missing";
  if (paths.length === 0) return "empty";
  const rest = paths.filter((path) => !VERSION_FILES.has(path));
  if (rest.length === 0) return "version only";
  return rest.every((path) => TEST_PATH.test(path)) ? "tests only" : "mixed";
}

const DIMENSION = /^###\s+(Tests|Standards)\s*$/;
const ITEM = /^(?:[-*+]|\d+[.)])\s/;

// The findings of one lister report, each item's lines joined into one.
export function splitFindings(prose) {
  const findings = [];
  let heading = null;
  let current = null;
  let afterBlank = false;
  for (const line of prose.split("\n")) {
    const blank = line.trim() === "";
    if (/^#{1,6}\s/.test(line) || line.includes("<verdict>")) {
      heading = DIMENSION.exec(line)?.[1] ?? null;
      current = null;
    } else if (heading !== null && !blank) {
      if (current === null || ITEM.test(line) || (afterBlank && !/^\s/.test(line))) {
        current = { heading, lines: [] };
        findings.push(current);
      }
      current.lines.push(line.trim());
    }
    afterBlank = blank;
  }
  return findings.map(({ heading, lines }) => ({ heading, text: lines.join(" ") }));
}

const totalTokens = ({ input, cached, cacheWrite, output }) => {
  const measured = [input, cached, cacheWrite, output].filter((value) => value !== null);
  return measured.length === 0 ? null : measured.reduce((a, b) => a + b, 0);
};

const addShare = (sum, share) => (share === null ? sum : (sum ?? 0) + share);

// `paths` maps each fixer sha to the paths it touches (`readCommitPaths`).
export function classify(report, paths) {
  const key = (row) => `${row.run}/${row.issue}/${row.attempt}`;
  const fixerTokens = new Map();
  for (const row of report.invocations.filter((row) => row.role === "quality-fix")) {
    fixerTokens.set(key(row), addShare(fixerTokens.get(key(row)) ?? null, totalTokens(row.tokens)));
  }
  const reports = report.invocations.filter((row) =>
    row.role === "quality-list" && row.verdict === "CHANGES-REQUESTED");
  const spoken = reports.filter((row) => typeof row.prose === "string");
  const perAttempt = new Map();
  const findings = spoken.flatMap((row) => {
    const found = splitFindings(row.prose);
    const lister = totalTokens(row.tokens);
    perAttempt.set(key(row), (perAttempt.get(key(row)) ?? 0) + found.length);
    return found.map((finding) => ({
      row, ...finding,
      class: classifyFinding(finding.text),
      listerShare: lister === null ? null : lister / found.length,
    }));
  });

  const classes = new Map([...FINDING_CLASSES.map(([name]) => name), "unclassified"]
    .map((name) => [name, { findings: 0, listerTokens: null, fixerTokens: null }]));
  for (const { row, class: name, listerShare } of findings) {
    const tally = classes.get(name);
    const fixer = fixerTokens.get(key(row)) ?? null;
    tally.findings += 1;
    tally.listerTokens = addShare(tally.listerTokens, listerShare);
    tally.fixerTokens = addShare(tally.fixerTokens, fixer === null ? null : fixer / perAttempt.get(key(row)));
  }

  const commits = new Map(COMMIT_CLASSES.map((name) => [name, 0]));
  for (const sha of report.invocations.flatMap((row) => row.shas ?? [])) {
    const name = classifyCommit(paths.get(sha));
    commits.set(name, commits.get(name) + 1);
  }

  return {
    reports: reports.length,
    withoutSpeech: reports.length - spoken.length,
    findings: findings.length,
    classes,
    commits,
    unclassified: findings
      .filter((finding) => finding.class === "unclassified")
      .map(({ row, heading, text }) => ({ run: row.run, issue: row.issue, attempt: row.attempt, heading, text })),
  };
}

const formatTokens = (value) => (value === null ? "-" : String(Math.round(value)));

const table = (header, rows) => {
  const widths = header.map((_, i) => Math.max(...[header, ...rows].map((row) => String(row[i]).length)));
  return [header, ...rows]
    .map((row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
};

export function renderClassification(result) {
  const share = (n) => (result.findings === 0 ? "-" : `${Math.round((100 * n) / result.findings)}%`);
  const commitTotal = [...result.commits.values()].reduce((a, b) => a + b, 0);
  return [
    `Quality findings: ${result.findings} from ${result.reports} CHANGES-REQUESTED lister reports` +
      ` (${result.withoutSpeech} without speech)`,
    table(["class", "findings", "share", "lister tokens", "fixer tokens"],
      [...result.classes].map(([name, tally]) => [
        name, tally.findings, share(tally.findings),
        formatTokens(tally.listerTokens), formatTokens(tally.fixerTokens),
      ])),
    "",
    `Fixer commits: ${commitTotal}`,
    table(["class", "commits"], [...result.commits]),
    "",
    `Unclassified findings: ${result.unclassified.length}`,
    ...result.unclassified.map(({ run, issue, attempt, heading, text }) =>
      `${run} #${issue} attempt ${attempt} [${heading}] ${text}`),
    "",
  ].join("\n");
}

const git = (repo, args, input) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });

// The paths each commit touches, or null for a sha the repo does not have.
export function readCommitPaths(repo, shas) {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return new Map();
  const types = git(repo, ["cat-file", "--batch-check=%(objecttype)"],
    unique.map((sha) => `${sha}^{commit}\n`).join("")).split("\n");
  return new Map(unique.map((sha, i) => [
    sha,
    types[i] === "commit"
      ? git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", sha]).split("\0").filter(Boolean)
      : null,
  ]));
}

const USAGE = "usage: stats-classify.mjs <report.json> [--repo <dir>]";

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { repo: { type: "string", default: "." } },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    if (!(err instanceof TypeError && String(err.code).startsWith("ERR_PARSE_ARGS_"))) throw err;
    return { error: err.message };
  }
  const [path, ...extra] = parsed.positionals;
  if (path === undefined || extra.length > 0) return { error: "name exactly one report" };
  const report = JSON.parse(await readFile(path, "utf8"));
  if (!report.invocations.every((row) => "prose" in row && "shas" in row)) {
    return { error: "the report carries no prose or no shas: rerun stats with --json --with-prose" };
  }
  const shas = report.invocations.flatMap((row) => row.shas ?? []);
  return { output: renderClassification(classify(report, readCommitPaths(parsed.values.repo, shas))) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await main(process.argv.slice(2));
  if ("error" in result) {
    console.error(`${result.error}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    process.stdout.write(result.output);
  }
}
