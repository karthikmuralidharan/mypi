/**
 * Stage resolution for the /loop-stats dashboard, in two layers:
 *
 * 1. PRE-PR (loop Stage 0-7): no PR-derived signal exists yet, so this is
 *    derived from `.loop/state/<branch>.json` alone (see loop-state.ts) --
 *    a local fs read, no `gh` call. Coarser than the PR-derived layer below,
 *    but it is the only signal available before a PR exists.
 * 2. PR-DERIVED (loop Stage 8-10): the original mechanism this file always
 *    had -- `gh` PR + linked-issue lookup, review decision, CI rollup,
 *    checklist completion. Unchanged from before, except that a JIRA key
 *    already known from state (authoritative -- written directly by `sync
 *    mirror-jira`, not regex-parsed from free text) is preferred over the
 *    one parsed out of the issue body when both are available.
 *
 * SCOPE CUT this replaces, stated plainly for the record: before this loop
 * skill persisted `.loop/state/<branch>.json` (see docs/OMP-PORT-PLAN.md's
 * original investigation), a branch with no PR yet genuinely could not be
 * told apart between Stage 0 (no ticket) and Stage 4-7 (ticket exists,
 * still implementing) without guessing via title/keyword search -- worse
 * than admitting the limit. The state file now records exactly the facts
 * (`.issue`, `.pr`, gate approvals) needed to tell those apart for free.
 */

import { execFile } from "node:child_process";
import { localStageBucket, type LoopState } from "./loop-state.ts";

export interface StageInfo {
  label: string;
  url?: string;
  checklist?: { done: number; total: number };
  jiraKey?: string;
}

export interface GhPr {
  number: number;
  state: string; // "OPEN" | "MERGED" | "CLOSED"
  url: string;
  body: string;
  reviewDecision: string | null;
  statusCheckRollup: unknown[];
  title: string;
}

export interface GhIssue {
  body: string;
  url: string;
}

export type RunGh = (args: string[]) => Promise<string>;

function defaultRunGh(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

/** Counts `- [ ]` / `- [x]` checklist items (case-insensitive x) in a GH issue/markdown body. */
export function parseChecklist(
  body: string,
): { done: number; total: number } | undefined {
  const items = body.match(/^\s*[-*]\s*\[([ xX])\]/gm);
  if (!items || items.length === 0) return undefined;
  const done = items.filter((item) => /\[[xX]\]/.test(item)).length;
  return { done, total: items.length };
}

/** Parses the `JIRA: <KEY>` marker the loop skill writes into an issue body (see SKILL.md, Stage 4). */
export function parseJiraKey(body: string): string | undefined {
  const match = body.match(/JIRA:\s*([A-Z][A-Z0-9]+-\d+)/);
  return match?.[1];
}

/** Parses a GitHub closing-keyword reference ("Closes #12", "fixes #7", ...) to an issue number. */
export function parseClosesIssueNumber(body: string): number | undefined {
  const match = body.match(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i,
  );
  return match ? Number(match[1]) : undefined;
}

type CiStatus = "failing" | "pending" | "passing" | "none";

/**
 * Classifies a PR's `statusCheckRollup` into one aggregate status.
 *
 * Best-effort heuristic, NOT verified against a real failing-CI PR live —
 * only structurally, against constructed fixtures in stage.test.ts. `gh`'s
 * rollup shape has drifted across versions (older releases used `state`,
 * newer use `conclusion`), so this scans every string value in each entry
 * rather than committing to one field name.
 */
export function ciStatus(rollup: unknown[]): CiStatus {
  if (!rollup || rollup.length === 0) return "none";
  const FAILING = /^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED)$/;
  const PENDING = /^(PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING)$/;
  let sawPending = false;
  for (const entry of rollup) {
    if (typeof entry !== "object" || entry === null) continue;
    const values = Object.values(entry as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string",
    );
    if (values.some((v) => FAILING.test(v.toUpperCase()))) return "failing";
    if (values.some((v) => PENDING.test(v.toUpperCase()))) sawPending = true;
  }
  return sawPending ? "pending" : "passing";
}

/** Pure label decision for an OPEN pull request. */
export function computeOpenPrLabel(
  pr: Pick<GhPr, "reviewDecision" | "statusCheckRollup">,
): string {
  const ci = ciStatus(pr.statusCheckRollup);
  if (ci === "failing") return "PR open · CI failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return "PR open · changes requested";
  if (ci === "pending") return "PR open · CI running";
  if (pr.reviewDecision === "APPROVED") return "PR open · ship-gate clear";
  return "PR open · awaiting review";
}

/** Pure combine: a PR plus its optionally-resolved linked issue, into one `StageInfo`. */
export function stageFromPr(pr: GhPr, issue?: GhIssue): StageInfo {
  const jiraKey = issue ? parseJiraKey(issue.body) : undefined;
  const checklist = issue ? parseChecklist(issue.body) : undefined;

  let label: string;
  if (pr.state === "MERGED") label = "merged";
  else if (pr.state === "CLOSED") label = "closed (not merged)";
  else label = computeOpenPrLabel(pr);

  return { label, url: pr.url, checklist, jiraKey };
}

/**
 * Pre-PR stage label, derived from `.loop/state/<branch>.json` alone (no
 * `gh` call -- see loop-state.ts's `localStageBucket`). Used only when
 * `resolveStage` finds no PR at all; once a PR exists, `stageFromPr` above
 * takes over with its finer-grained, PR-derived label.
 */
export function stageFromLoopState(state: LoopState | undefined): StageInfo {
  const bucket = localStageBucket(state);
  let label: string;
  if (bucket !== "spec_plan") {
    label = "implementing (Stage 5-7, no PR yet)";
  } else if (state?.gate1?.approved) {
    label = "plan approved · pre-issue (Stage 2-4)";
  } else {
    label = "spec/plan (Stage 0-2, pre-GATE 1)";
  }
  return { label, jiraKey: state?.jira };
}

export async function resolveStage(
  repoSlug: string,
  branch: string,
  opts: { runGh?: RunGh; timeoutMs?: number; loopState?: LoopState } = {},
): Promise<StageInfo> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const runGh =
    opts.runGh ?? ((args: string[]) => defaultRunGh(args, timeoutMs));

  try {
    const prJson = await runGh([
      "pr",
      "list",
      "--repo",
      repoSlug,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,url,body,reviewDecision,statusCheckRollup,title",
      "--limit",
      "1",
    ]);
    const prs = JSON.parse(prJson) as GhPr[];
    if (prs.length === 0) {
      // No PR-derived signal exists yet. Before state.ts existed, this was
      // always "no PR yet" full stop -- keep that exact fallback when no
      // loopState is passed (backward compatible), and use the richer,
      // state-derived label when it is available.
      return opts.loopState !== undefined
        ? stageFromLoopState(opts.loopState)
        : { label: "no PR yet" };
    }

    const pr = prs[0];
    const issueNumber = parseClosesIssueNumber(pr.body);
    let issue: GhIssue | undefined;
    if (issueNumber !== undefined) {
      try {
        const issueJson = await runGh([
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          repoSlug,
          "--json",
          "body,url",
        ]);
        issue = JSON.parse(issueJson) as GhIssue;
      } catch {
        /* issue lookup is a nice-to-have (checklist/JIRA key); PR status stands without it */
      }
    }
    const stage = stageFromPr(pr, issue);
    // state.jira is authoritative (written directly by `sync mirror-jira`);
    // prefer it over the regex-parsed marker when both are known.
    if (opts.loopState?.jira) stage.jiraKey = opts.loopState.jira;
    return stage;
  } catch {
    return { label: "unknown" };
  }
}
