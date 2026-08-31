// The one create-or-update pull request primitive (#62).
//
// Sandbar opens exactly two kinds of pull request, and they have almost
// nothing in common except the `gh` dance that opens them:
//
//   * the VERIFIED-MODE integration PR (#22, forge-verify.ts) — a scratch
//     ref's audit handle, not a draft, closed by sandbar the moment its cycle
//     is abandoned;
//   * the CHUNK PR (#62, chunk-pr.ts + merger.ts) — a durable review surface
//     for a review-gated chunk, opened as a DRAFT and left open for as long as
//     the review takes. Since #64 sandbar does close one, but only on the far
//     side of the landing it asked for, and through its own `gh pr close`
//     rather than through anything here.
//
// What they share is the discipline, and it is the part that is easy to get
// subtly wrong twice: find the open PR for this head→base pair, RE-TITLE and
// RE-BODY it if there is one, create it if there is not, and come back with a
// number even when `gh` answered in a shape we only half recognise. Written
// out at both call sites that is forty lines of argv duplicated across two
// modules — and argv duplicated is argv that drifts, which is exactly the
// class of bug `gh-argv.test.ts` exists to catch.
//
// Create-or-update rather than create-if-missing, because a PR that outlived
// an earlier cycle and still describes it is a wrong record — the one thing
// neither an audit handle nor a review surface may be.
//
// DRAFT IS A CREATE-TIME ARGUMENT ONLY, and that asymmetry is deliberate
// (#54 Q14, #62). Draft state is what disables GitHub's merge button while
// leaving review fully functional, so sandbar opens a chunk PR as a draft. But
// a human marking that PR ready for review is a deliberate override, and this
// function must not undo it on the next cycle: it re-titles and re-bodies an
// existing PR and touches nothing else. A chunk a human then merged themselves
// is reconciled by #64's plan-time pass — which reads git rather than draft
// state — so nothing here needs a flag flip behind their back.
//
// The process seam mirrors forge-verify's `ExecFn` for the same reason: the
// bugs in a shell-out layer are in its argv, and no fake adapter can see argv.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `gh pr list --json` on a busy head, and `gh pr create`'s echoed URL. Same
// ceiling forge-verify uses for its own gh reads.
const MAX_BUFFER = 50 * 1024 * 1024;

export type PullRequestRef = {
  readonly number: number;
  readonly url: string;
};

export type PrExec = (
  file: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly maxBuffer?: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const defaultExec: PrExec = (file, args, opts) =>
  execFileAsync(file, [...args], opts);

export type EnsurePullRequestArgs = {
  // A git checkout to run `gh` from. `--repo` is what actually names the
  // repository (#34); the cwd only keeps `gh` from resolving one of its own.
  readonly cwd: string;
  // `owner/name`, ready for `--repo`.
  readonly repoFlag: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  // Create as a draft. Consulted ON CREATE ONLY — see the header.
  readonly draft?: boolean;
  readonly exec?: PrExec;
};

/**
 * Ensure an open PR for `head` → `base`, with this call's title and body.
 *
 * Returns the PR's number and URL. A `number` of 0 means `gh` answered in a
 * shape this could not read a number out of — the PR itself is fine, and every
 * caller treats the 0 as "no handle", never as "no PR".
 */
export async function ensurePullRequest(
  args: EnsurePullRequestArgs,
): Promise<PullRequestRef> {
  const exec = args.exec ?? defaultExec;
  const { cwd, repoFlag } = args;
  const { stdout } = await exec(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repoFlag,
      "--head",
      args.head,
      "--base",
      args.base,
      "--state",
      "open",
      "--json",
      "number,url",
    ],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  const existing: unknown = JSON.parse(stdout.trim() || "[]");
  if (Array.isArray(existing) && existing.length > 0) {
    const o = existing[0] as Record<string, unknown>;
    const number = typeof o["number"] === "number" ? o["number"] : 0;
    const url = typeof o["url"] === "string" ? o["url"] : "";
    // Re-title and re-body it, and nothing else: not the draft state (header),
    // not the base, not the labels a human put on it.
    if (number > 0) {
      await exec(
        "gh",
        [
          "pr",
          "edit",
          String(number),
          "--repo",
          repoFlag,
          "--title",
          args.title,
          "--body",
          args.body,
        ],
        { cwd, maxBuffer: MAX_BUFFER },
      );
    }
    return { number, url };
  }
  const created = await exec(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repoFlag,
      ...(args.draft === true ? ["--draft"] : []),
      "--head",
      args.head,
      "--base",
      args.base,
      "--title",
      args.title,
      "--body",
      args.body,
    ],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  const url = created.stdout.trim().split("\n").pop() ?? "";
  const m = url.match(/\/pull\/(\d+)/);
  return { number: m && m[1] ? Number(m[1]) : 0, url };
}
