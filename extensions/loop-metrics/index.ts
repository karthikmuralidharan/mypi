/**
 * loop-metrics: per-task AI usage console for /loop-managed repos.
 *
 * Task identity = current git branch, scoped to repos where `.loop/config.json`
 * exists (see scope.ts). Metrics accumulate turn-by-turn (turn_start -> ...
 * -> turn_end) into a SQLite store (store.ts), then `/loop-stats` renders them
 * plus a best-effort, GitHub-derived ship-gate stage (stage.ts).
 */

import { execFile } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { buildDashboardItems } from "./dashboard.ts";
import { getRepoContext } from "./git.ts";
import { isLoopRepo } from "./scope.ts";
import { resolveStage, type StageInfo } from "./stage.ts";
import { listTasks, recordTurn } from "./store.ts";
import { taskKey, type TurnDelta, zeroDelta } from "./types.ts";

interface InFlightTurn {
  repoSlug: string;
  branch: string;
  cwd: string;
  startedAt: number;
  delta: TurnDelta;
}

function openUrl(url: string): void {
  let opener = "xdg-open";
  if (process.platform === "darwin") opener = "open";
  else if (process.platform === "win32") opener = "start";
  try {
    execFile(opener, [url]);
  } catch {
    /* best effort — never let "open the browser" crash the command */
  }
}

async function runDashboard(ctx: ExtensionCommandContext): Promise<void> {
  const tasks = listTasks();
  if (tasks.length === 0) {
    ctx.ui.notify(
      "No tracked /loop tasks yet — nothing recorded in a .loop-managed repo.",
      "info",
    );
    return;
  }

  const repo = getRepoContext(ctx.cwd);
  const currentKey = repo ? taskKey(repo.repoSlug, repo.branch) : undefined;
  // Only fetch live stage for the current repo's tasks — bounded, so opening
  // the dashboard never hangs on gh calls for repos you aren't looking at.
  const relevantTasks = repo
    ? tasks.filter((t) => t.repoSlug === repo.repoSlug)
    : [];

  const stages = await ctx.ui.custom<Map<string, StageInfo>>(
    (tui, theme, _kb, done) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        "Checking ship-gate status\u2026",
      );
      loader.onAbort = () => done(new Map());
      Promise.all(
        relevantTasks.map(
          async (t) =>
            [
              taskKey(t.repoSlug, t.branch),
              await resolveStage(t.repoSlug, t.branch),
            ] as const,
        ),
      )
        .then((entries) => done(new Map(entries)))
        .catch(() => done(new Map()));
      return loader;
    },
  );

  const items = buildDashboardItems(tasks, { stages, currentKey });
  const selectItems: SelectItem[] = items.map((it) => ({
    value: it.value,
    label: it.label,
    description: it.description,
  }));

  const chosen = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("/loop-stats \u2014 tracked tasks")),
        1,
        0,
      ),
    );
    const selectList = new SelectList(
      selectItems,
      Math.min(selectItems.length, 10),
      {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    );
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          "\u2191\u2193 navigate \u2022 enter open in browser \u2022 esc close",
        ),
        1,
        0,
      ),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!chosen) return;
  const item = items.find((it) => it.value === chosen);
  if (item?.url) openUrl(item.url);
  else ctx.ui.notify("No PR/issue URL resolved for that task yet.", "info");
}

export default function loopMetricsExtension(pi: ExtensionAPI) {
  let currentTurn: InFlightTurn | null = null;

  pi.on("turn_start", async (event, ctx) => {
    currentTurn = null;
    try {
      const repo = getRepoContext(ctx.cwd);
      if (!repo || !isLoopRepo(repo.repoRoot)) return;
      currentTurn = {
        repoSlug: repo.repoSlug,
        branch: repo.branch,
        cwd: ctx.cwd,
        startedAt: event.timestamp,
        delta: zeroDelta(),
      };
    } catch {
      currentTurn = null; // tracking must never break the user's turn
    }
  });

  pi.on("message_end", async (event) => {
    if (!currentTurn || event.message.role !== "assistant") return;
    const usage = event.message.usage;
    if (!usage) return;
    const t = currentTurn.delta.tokens;
    t.input += usage.input;
    t.output += usage.output;
    t.cacheRead += usage.cacheRead;
    t.cacheWrite += usage.cacheWrite;
    t.total += usage.totalTokens;
    const c = currentTurn.delta.cost;
    c.input += usage.cost.input;
    c.output += usage.cost.output;
    c.cacheRead += usage.cost.cacheRead;
    c.cacheWrite += usage.cost.cacheWrite;
    c.total += usage.cost.total;
  });

  pi.on("tool_execution_end", async (event) => {
    if (!currentTurn) return;
    currentTurn.delta.toolCalls.total += 1;
    const byName = currentTurn.delta.toolCalls.byName;
    byName[event.toolName] = (byName[event.toolName] ?? 0) + 1;
  });

  pi.on("turn_end", async () => {
    const turn = currentTurn;
    currentTurn = null;
    if (!turn) return;
    turn.delta.durationMs = Date.now() - turn.startedAt;
    try {
      recordTurn({
        repoSlug: turn.repoSlug,
        branch: turn.branch,
        cwd: turn.cwd,
        delta: turn.delta,
      });
    } catch (err) {
      console.error("[loop-metrics] failed to record turn:", err);
    }
  });

  pi.registerCommand("loop-stats", {
    description: "Show per-task AI usage stats for /loop-managed repos",
    handler: async (_args, ctx) => {
      await runDashboard(ctx);
    },
  });
}
