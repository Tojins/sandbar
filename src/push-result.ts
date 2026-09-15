// Classification shared by every ordinary git push Sandbar makes (#163).
//
// Git distinguishes a client-side ref race from a server-side refusal in the
// status line itself:
//
//   ! [rejected]        HEAD -> main (non-fast-forward)
//   ! [remote rejected] HEAD -> branch (pre-receive hook declined)
//
// The former says the destination moved and may be retried after refreshing
// it. The latter says the server refused this content or ref: workflow-token
// scope, push protection, rulesets, size limits and pre-receive hooks all land
// there. Treating the word "rejected" without its bracketed status collapsed
// those two facts and turned permanent per-branch content refusals into races.
//
// A failure with no such ref-status line is transport/infrastructure. It stays
// fatal; an unreachable origin says nothing about the branch being pushed.

export type PushResult =
  | { readonly kind: "ok" }
  | { readonly kind: "race" }
  | { readonly kind: "refused"; readonly reasons: readonly string[] }
  | { readonly kind: "fatal"; readonly reason: string };

// The durable local copy a refusal leaves behind. `repoDir` is the host-side
// bare cache in which `ref` resolves; unlike the ephemeral issue and merger
// worktrees, both survive the landing pass.
export type LocalBranchRecovery = {
  readonly tipSha: string;
  readonly ref: string;
  readonly repoDir: string;
};

export function pushErrorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  if (stderr) return stderr;
  return typeof e?.message === "string" ? e.message : String(err);
}

export function classifyPushError(err: unknown): PushResult {
  const e = err as { stderr?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const statusLines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const refused = statusLines.filter((line) =>
    /!\s+\[remote rejected\]/i.test(line),
  );
  if (refused.length > 0) return { kind: "refused", reasons: refused };

  if (
    statusLines.some((line) =>
      /!\s+\[rejected\].*\((?:non-fast-forward|fetch first|stale info)\)\s*$/i.test(
        line,
      ),
    )
  ) {
    return { kind: "race" };
  }

  return { kind: "fatal", reason: pushErrorDetail(err) };
}
