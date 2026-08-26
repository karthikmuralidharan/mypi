/**
 * Posts (or updates in place) one "loop-metrics" marker comment on the
 * branch's tracked GH issue, summarizing per-stage token/cost/duration.
 *
 * SCOPING, deliberately: this is a write-only, low-frequency rollup, not a
 * data store. `store.ts`'s SQLite database remains the only source of
 * truth for metrics -- it is queried, aggregated, and correctly serializes
 * concurrent writers. A GH issue body has none of that: no read-modify-write
 * primitive (two concurrent /loop sessions editing the same comment would
 * lose updates to each other), a shared 5,000 req/hr rate limit across all
 * `gh` usage on the token (verified live against this repo's own account),
 * and real per-call network latency. None of that is acceptable at
 * per-turn frequency, which is exactly why this is only ever called on a
 * detected stage TRANSITION (see store.ts's `isStageTransition`) -- a
 * handful of times per feature's whole lifecycle, not per turn.
 *
 * "Update one comment in place" (not append-only) is a deliberate choice:
 * this extension is the only writer of its own marker comment, so there is
 * no concurrent-editor race to guard against for the comment itself --
 * only the metrics turn recording (already serialized by SQLite) needs
 * that protection. One place to look beats a growing timeline of near-
 * duplicate comments on a long-running issue.
 */

import { spawn } from "node:child_process";
import { humanizeCost, humanizeCount, humanizeDuration } from "./format.ts";
import { STAGE_BUCKETS, STAGE_BUCKET_LABELS } from "./loop-state.ts";
import type { TaskStats } from "./types.ts";

const MARKER = "<!-- loop-metrics:v1 -->";

export type RunGh = (
  args: string[],
  opts?: { input?: string },
) => Promise<string>;

function defaultRunGh(
  args: string[],
  opts?: { input?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr}`));
    });
    if (opts?.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export interface GhComment {
  id: number;
  body: string;
}

/** Pure: renders the rollup comment body for a task. Exported for direct
 * unit testing without a `gh` call. */
export function formatRollupComment(stats: TaskStats): string {
  const rows = STAGE_BUCKETS.flatMap((b) => {
    const s = stats.stageBreakdown[b];
    if (!s || s.turns === 0) return [];
    return [
      `| ${STAGE_BUCKET_LABELS[b]} | ${s.turns} | ${humanizeCount(s.tokens.total)} | ${humanizeCost(s.cost.total)} |`,
    ];
  });
  return [
    MARKER,
    "**/loop-stats rollup** (auto-updated by loop-metrics on each stage transition)",
    "",
    `- Turns: ${stats.turns}`,
    `- Duration: ${humanizeDuration(stats.durationMs)}`,
    `- Tokens: ${humanizeCount(stats.tokens.total)}`,
    `- Cost: ${humanizeCost(stats.cost.total)}`,
    "",
    "| Stage | Turns | Tokens | Cost |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/**
 * Finds this extension's own marker comment on an issue, if one exists.
 * `--paginate` applies `-q` per page, so this is correct regardless of how
 * many prior comments (human, bot, or otherwise) already exist on a
 * long-running issue.
 */
async function findMarkerComment(
  runGh: RunGh,
  repoSlug: string,
  issueNumber: number,
): Promise<GhComment | undefined> {
  const out = await runGh([
    "api",
    `repos/${repoSlug}/issues/${issueNumber}/comments`,
    "--paginate",
    "-q",
    ".[] | {id, body}",
  ]);
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const comment = JSON.parse(line) as GhComment;
      if (comment.body.startsWith(MARKER)) return comment;
    } catch {
      /* skip a malformed line rather than fail the whole scan */
    }
  }
  return undefined;
}

/**
 * Finds-or-creates and updates the marker comment on `issueNumber`, in
 * place -- never posts a second one. Best-effort: any failure (auth, rate
 * limit, deleted issue, network) is swallowed here. Callers must never let
 * this block or fail a turn -- see index.ts, which fires this without
 * awaiting it from `turn_end`.
 */
export async function postRollup(
  repoSlug: string,
  issueNumber: number,
  stats: TaskStats,
  opts: { runGh?: RunGh } = {},
): Promise<void> {
  const runGh = opts.runGh ?? defaultRunGh;
  const body = formatRollupComment(stats);
  try {
    const existing = await findMarkerComment(runGh, repoSlug, issueNumber);
    if (existing) {
      await runGh(
        [
          "api",
          "--method",
          "PATCH",
          `repos/${repoSlug}/issues/comments/${existing.id}`,
          "--input",
          "-",
        ],
        { input: JSON.stringify({ body }) },
      );
    } else {
      await runGh(
        [
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          repoSlug,
          "--body-file",
          "-",
        ],
        { input: body },
      );
    }
  } catch {
    /* best-effort rollup -- auth/rate-limit/deleted-issue failures must never surface */
  }
}

/** Parses `sync.sh`'s `"#42"` issue-number format into a bare number, or
 * `undefined` for anything that doesn't match (defensive -- state.issue is
 * agent-observed text, not a validated schema). */
export function parseIssueNumber(
  issue: string | undefined,
): number | undefined {
  if (!issue) return undefined;
  const match = issue.match(/^#?(\d+)$/);
  return match ? Number(match[1]) : undefined;
}
