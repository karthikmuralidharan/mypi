/**
 * Best-effort ship-gate stage, derived entirely from `gh` (GitHub CLI) —
 * deliberately GitHub-only, per the scoping decision made with the user
 * (live JIRA status would need Atlassian credentials this extension doesn't
 * otherwise require; a JIRA key is still surfaced when the loop skill wrote
 * its `JIRA: <KEY>` marker into the issue body, just not queried live).
 *
 * SCOPE CUT, stated plainly: without a stored branch->issue mapping (the loop
 * skill never persists one — see `docs/OMP-PORT-PLAN.md` investigation), a
 * branch with no PR yet cannot be reliably distinguished between Stage 0
 * (no ticket) and Stage 4-7 (ticket exists, still implementing). Guessing via
 * title/keyword search against the branch name would produce false-positive
 * matches on unrelated issues, which is worse than admitting the limit. So:
 * no PR -> "no PR yet", full stop. Once a PR exists, `Closes #<n>` in its body
 * reliably resolves the linked issue for checklist + JIRA-key parsing.
 */

import { execFile } from "node:child_process";

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

export async function resolveStage(
  repoSlug: string,
  branch: string,
  opts: { runGh?: RunGh; timeoutMs?: number } = {},
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
    if (prs.length === 0) return { label: "no PR yet" };

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
    return stageFromPr(pr, issue);
  } catch {
    return { label: "unknown" };
  }
}
