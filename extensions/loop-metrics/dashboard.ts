/**
 * /loop-stats dashboard: pure item-building logic here, thin TUI wiring in
 * index.ts. Split so the interesting behavior (sorting, formatting, current-
 * task marking) is unit-testable without a terminal.
 */

import {
  humanizeCost,
  humanizeCount,
  humanizeDuration,
  relativeTime,
} from "./format.ts";
import { STAGE_BUCKETS, STAGE_BUCKET_LABELS } from "./loop-state.ts";
import type { StageInfo } from "./stage.ts";
import type { TaskStats } from "./types.ts";

export interface DashboardItem {
  value: string; // task key, for select-result plumbing
  label: string;
  description: string;
  url?: string;
}

/** Most recently active first. */
export function sortTasks(tasks: TaskStats[]): TaskStats[] {
  return [...tasks].sort(
    (a, b) => Date.parse(b.lastActiveIso) - Date.parse(a.lastActiveIso),
  );
}

function formatStage(stage: StageInfo | undefined): string {
  if (!stage) return "stage: —";
  const bits = [stage.label];
  if (stage.checklist)
    bits.push(`${stage.checklist.done}/${stage.checklist.total} done`);
  if (stage.jiraKey) bits.push(stage.jiraKey);
  return bits.join(" · ");
}

/**
 * Compact per-stage token breakdown, e.g. "spec/plan 1.2K · implementing
 * 8.4K · shipping 3.1K" — only for buckets the task actually has a turn in,
 * and only shown at all once a task has spread across more than one bucket
 * (a single-bucket task's breakdown is just its total again, not new
 * information).
 */
function formatStageBreakdown(stats: TaskStats): string | undefined {
  const present = STAGE_BUCKETS.filter(
    (b) => (stats.stageBreakdown[b]?.turns ?? 0) > 0,
  );
  if (present.length < 2) return undefined;
  return present
    .map(
      (b) =>
        `${STAGE_BUCKET_LABELS[b]} ${humanizeCount(stats.stageBreakdown[b]?.tokens.total ?? 0)}`,
    )
    .join(" · ");
}

export function formatTaskItem(
  stats: TaskStats,
  opts: { stage?: StageInfo; isCurrent?: boolean } = {},
): DashboardItem {
  const label = `${opts.isCurrent ? "● " : ""}${stats.branch}  ·  ${stats.repoSlug}`;
  const jiraKey = opts.stage?.jiraKey ?? stats.jiraKey;
  const bits = [
    `⏱ ${humanizeDuration(stats.durationMs)}`,
    `🔁 ${stats.turns} turns`,
    `🪙 ${humanizeCount(stats.tokens.total)} tok`,
    `💵 ${humanizeCost(stats.cost.total)}`,
    `🔧 ${humanizeCount(stats.toolCalls.total)} calls`,
    formatStage(opts.stage),
  ];
  // jiraKey can come from the persisted task (stats.jiraKey) even when no
  // live stage was resolved this render — formatStage alone would miss it.
  if (jiraKey && !opts.stage?.jiraKey) bits.push(jiraKey);
  const breakdown = formatStageBreakdown(stats);
  if (breakdown) bits.push(`(${breakdown})`);
  bits.push(relativeTime(stats.lastActiveIso));
  const description = bits.join("  ");

  return {
    value: `${stats.repoSlug}::${stats.branch}`,
    label,
    description,
    url: opts.stage?.url,
  };
}

export function buildDashboardItems(
  tasks: TaskStats[],
  opts: { stages?: Map<string, StageInfo>; currentKey?: string } = {},
): DashboardItem[] {
  return sortTasks(tasks).map((task) => {
    const key = `${task.repoSlug}::${task.branch}`;
    return formatTaskItem(task, {
      stage: opts.stages?.get(key),
      isCurrent: key === opts.currentKey,
    });
  });
}
