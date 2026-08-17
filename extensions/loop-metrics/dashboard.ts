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

export function formatTaskItem(
  stats: TaskStats,
  opts: { stage?: StageInfo; isCurrent?: boolean } = {},
): DashboardItem {
  const label = `${opts.isCurrent ? "● " : ""}${stats.branch}  ·  ${stats.repoSlug}`;
  const description = [
    `⏱ ${humanizeDuration(stats.durationMs)}`,
    `🔁 ${stats.turns} turns`,
    `🪙 ${humanizeCount(stats.tokens.total)} tok`,
    `💵 ${humanizeCost(stats.cost.total)}`,
    `🔧 ${humanizeCount(stats.toolCalls.total)} calls`,
    formatStage(opts.stage),
    relativeTime(stats.lastActiveIso),
  ].join("  ");

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
