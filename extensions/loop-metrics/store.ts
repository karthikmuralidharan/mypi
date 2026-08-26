/**
 * Persistent per-task store, backed by `node:sqlite` at `<dataDir>/tasks.db`.
 *
 * WHY SQLITE OVER A JSON FILE + HAND-ROLLED LOCK (the original design here):
 * a /loop run routinely has more than one pi process writing to the same repo
 * at once (a main session plus a worktree session per `ce-worktree`), so
 * cross-process write serialization is a real requirement, not a hypothetical
 * one. SQLite's own file locking does that natively; a `BEGIN IMMEDIATE`
 * transaction blocks other writers until commit, so the read-modify-write in
 * `recordTurn` below is atomic across processes with no mutex of our own.
 *
 * WHY node:sqlite AND NOT better-sqlite3: pi always runs under Node (verified:
 * its CLI shebang is `#!/usr/bin/env node`), and better-sqlite3 is a native
 * binding whose ABI breaks across Node/pi upgrades — this project already has
 * a dedicated skill (rebuild-pi-native-modules) for exactly that failure, hit
 * by pi-hermes-memory's better-sqlite3 dependency. node:sqlite ships inside
 * Node itself, so there is no native module to rebuild and no ABI to mismatch.
 *
 * PRAGMA ORDER IS LOAD-BEARING. `busy_timeout` must be set before
 * `journal_mode=WAL`, not after. Verified empirically: with busy_timeout set
 * second, 25 real concurrent subprocesses each doing one read-increment-write
 * produced a final count of 15/25 with 10 "database is locked" crashes — the
 * WAL mode-switch itself raced with no retry budget yet. Swapping the order
 * (busy_timeout first) gave 25/25 across four separate runs of that same test,
 * zero errors. Do not reorder these two lines.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  StageBucket,
  StageBucketStats,
  TaskStats,
  TokenUsage,
  ToolCallStats,
  TurnDelta,
} from "./types.ts";
import { taskKey } from "./types.ts";

export function dataDir(): string {
  return (
    process.env.PI_LOOP_METRICS_DIR ||
    path.join(os.homedir(), ".pi", "agent", "loop-metrics")
  );
}

function dbPath(): string {
  return path.join(dataDir(), "tasks.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  key TEXT PRIMARY KEY,
  repo_slug TEXT NOT NULL,
  branch TEXT NOT NULL,
  cwd TEXT NOT NULL,
  first_seen_iso TEXT NOT NULL,
  last_active_iso TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  tool_calls_total INTEGER NOT NULL DEFAULT 0,
  tool_calls_by_name TEXT NOT NULL DEFAULT '{}',
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  cost_input REAL NOT NULL DEFAULT 0,
  cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  jira_key TEXT,
  stage_breakdown TEXT NOT NULL DEFAULT '{}',
  last_stage_bucket TEXT
);
`;

interface TaskRow {
  key: string;
  repo_slug: string;
  branch: string;
  cwd: string;
  first_seen_iso: string;
  last_active_iso: string;
  duration_ms: number;
  turns: number;
  tool_calls_total: number;
  tool_calls_by_name: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_total: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cost_total: number;
  jira_key: string | null;
  stage_breakdown: string;
  last_stage_bucket: string | null;
}

function rowToTaskStats(row: TaskRow): TaskStats {
  let byName: Record<string, number> = {};
  try {
    const parsed = JSON.parse(row.tool_calls_by_name);
    if (parsed && typeof parsed === "object") byName = parsed;
  } catch {
    /* corrupt byName blob — treat as empty rather than fail the whole read */
  }
  let stageBreakdown: Partial<Record<StageBucket, StageBucketStats>> = {};
  try {
    const parsed = JSON.parse(row.stage_breakdown);
    if (parsed && typeof parsed === "object") stageBreakdown = parsed;
  } catch {
    /* corrupt stage_breakdown blob — treat as empty rather than fail the read */
  }
  return {
    repoSlug: row.repo_slug,
    branch: row.branch,
    cwd: row.cwd,
    firstSeenIso: row.first_seen_iso,
    lastActiveIso: row.last_active_iso,
    durationMs: row.duration_ms,
    turns: row.turns,
    toolCalls: { total: row.tool_calls_total, byName },
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
      total: row.tokens_total,
    },
    cost: {
      input: row.cost_input,
      output: row.cost_output,
      cacheRead: row.cost_cache_read,
      cacheWrite: row.cost_cache_write,
      total: row.cost_total,
    },
    jiraKey: row.jira_key ?? undefined,
    stageBreakdown,
    lastStageBucket: (row.last_stage_bucket ?? undefined) as
      | StageBucket
      | undefined,
  };
}

/** Pure merge, exported for direct unit testing without touching the database. */
export function mergeTask(
  existing: TaskStats | undefined,
  input: {
    repoSlug: string;
    branch: string;
    cwd: string;
    delta: TurnDelta;
    stageBucket: StageBucket;
    jiraKey?: string;
  },
  nowIso: string,
): TaskStats {
  const jiraKey = input.jiraKey ?? existing?.jiraKey;
  const stageBreakdown = mergeStageBreakdown(
    existing?.stageBreakdown ?? {},
    input.stageBucket,
    input.delta,
  );
  if (!existing) {
    return {
      repoSlug: input.repoSlug,
      branch: input.branch,
      cwd: input.cwd,
      firstSeenIso: nowIso,
      lastActiveIso: nowIso,
      durationMs: input.delta.durationMs,
      turns: 1,
      toolCalls: input.delta.toolCalls,
      tokens: input.delta.tokens,
      cost: input.delta.cost,
      jiraKey,
      stageBreakdown,
      lastStageBucket: input.stageBucket,
    };
  }
  return {
    ...existing,
    cwd: input.cwd,
    lastActiveIso: nowIso,
    durationMs: existing.durationMs + input.delta.durationMs,
    turns: existing.turns + 1,
    toolCalls: sumToolCalls(existing.toolCalls, input.delta.toolCalls),
    tokens: sumAmounts(existing.tokens, input.delta.tokens),
    cost: sumAmounts(existing.cost, input.delta.cost),
    jiraKey,
    stageBreakdown,
    lastStageBucket: input.stageBucket,
  };
}

/** True when `input.stageBucket` differs from the task's previously recorded
 * bucket -- a real transition, not the first-ever turn (which is not a
 * "transition" from anything). Exported so index.ts's turn_end handler can
 * decide whether to post a GH rollup update without duplicating this logic. */
export function isStageTransition(
  existing: TaskStats | undefined,
  stageBucket: StageBucket,
): boolean {
  return (
    existing?.lastStageBucket !== undefined &&
    existing.lastStageBucket !== stageBucket
  );
}

/** Sums `delta` into `bucket`'s running stats, creating it on first use. Pure. */
function mergeStageBreakdown(
  existing: Partial<Record<StageBucket, StageBucketStats>>,
  bucket: StageBucket,
  delta: TurnDelta,
): Partial<Record<StageBucket, StageBucketStats>> {
  const prior = existing[bucket];
  const next: StageBucketStats = prior
    ? {
        stage: bucket,
        turns: prior.turns + 1,
        durationMs: prior.durationMs + delta.durationMs,
        tokens: sumAmounts(prior.tokens, delta.tokens),
        cost: sumAmounts(prior.cost, delta.cost),
      }
    : {
        stage: bucket,
        turns: 1,
        durationMs: delta.durationMs,
        tokens: delta.tokens,
        cost: delta.cost,
      };
  return { ...existing, [bucket]: next };
}

function sumAmounts(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

function sumToolCalls(a: ToolCallStats, b: ToolCallStats): ToolCallStats {
  const byName: Record<string, number> = { ...a.byName };
  for (const [name, count] of Object.entries(b.byName)) {
    byName[name] = (byName[name] ?? 0) + count;
  }
  return { total: a.total + b.total, byName };
}

/** Opens a connection with the load-bearing pragma order, runs `fn`, always closes. */
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  fs.mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(dbPath());
  try {
    db.exec("PRAGMA busy_timeout=5000"); // must precede journal_mode — see file header
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA);
    return fn(db);
  } finally {
    db.close();
  }
}

export function recordTurn(input: {
  repoSlug: string;
  branch: string;
  cwd: string;
  delta: TurnDelta;
  stageBucket: StageBucket;
  jiraKey?: string;
}): { task: TaskStats; transitioned: boolean } {
  return withDb((db) => {
    const key = taskKey(input.repoSlug, input.branch);
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT * FROM tasks WHERE key = :key")
        .get({ key }) as TaskRow | undefined;
      const existing = row ? rowToTaskStats(row) : undefined;
      const transitioned = isStageTransition(existing, input.stageBucket);
      const merged = mergeTask(existing, input, new Date().toISOString());
      db.prepare(
        `INSERT INTO tasks (
           key, repo_slug, branch, cwd, first_seen_iso, last_active_iso, duration_ms, turns,
           tool_calls_total, tool_calls_by_name,
           tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_total,
           cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
           jira_key, stage_breakdown, last_stage_bucket
         ) VALUES (
           :key, :repoSlug, :branch, :cwd, :firstSeenIso, :lastActiveIso, :durationMs, :turns,
           :toolCallsTotal, :toolCallsByName,
           :tokensInput, :tokensOutput, :tokensCacheRead, :tokensCacheWrite, :tokensTotal,
           :costInput, :costOutput, :costCacheRead, :costCacheWrite, :costTotal,
           :jiraKey, :stageBreakdown, :lastStageBucket
         )
         ON CONFLICT(key) DO UPDATE SET
           cwd = excluded.cwd,
           last_active_iso = excluded.last_active_iso,
           duration_ms = excluded.duration_ms,
           turns = excluded.turns,
           tool_calls_total = excluded.tool_calls_total,
           tool_calls_by_name = excluded.tool_calls_by_name,
           tokens_input = excluded.tokens_input,
           tokens_output = excluded.tokens_output,
           tokens_cache_read = excluded.tokens_cache_read,
           tokens_cache_write = excluded.tokens_cache_write,
           tokens_total = excluded.tokens_total,
           cost_input = excluded.cost_input,
           cost_output = excluded.cost_output,
           cost_cache_read = excluded.cost_cache_read,
           cost_cache_write = excluded.cost_cache_write,
           cost_total = excluded.cost_total,
           jira_key = excluded.jira_key,
           stage_breakdown = excluded.stage_breakdown,
           last_stage_bucket = excluded.last_stage_bucket`,
      ).run({
        key,
        repoSlug: merged.repoSlug,
        branch: merged.branch,
        cwd: merged.cwd,
        firstSeenIso: merged.firstSeenIso,
        lastActiveIso: merged.lastActiveIso,
        durationMs: merged.durationMs,
        turns: merged.turns,
        toolCallsTotal: merged.toolCalls.total,
        toolCallsByName: JSON.stringify(merged.toolCalls.byName),
        tokensInput: merged.tokens.input,
        tokensOutput: merged.tokens.output,
        tokensCacheRead: merged.tokens.cacheRead,
        tokensCacheWrite: merged.tokens.cacheWrite,
        tokensTotal: merged.tokens.total,
        costInput: merged.cost.input,
        costOutput: merged.cost.output,
        costCacheRead: merged.cost.cacheRead,
        costCacheWrite: merged.cost.cacheWrite,
        costTotal: merged.cost.total,
        jiraKey: merged.jiraKey ?? null,
        stageBreakdown: JSON.stringify(merged.stageBreakdown),
        lastStageBucket: merged.lastStageBucket ?? null,
      });
      db.exec("COMMIT");
      return { task: merged, transitioned };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
}

export function listTasks(): TaskStats[] {
  return withDb((db) => {
    // SAFETY: `SCHEMA` and `TaskRow` are defined together in this file and
    // kept in sync by hand -- `SELECT *` returns exactly TaskRow's columns.
    const rows = db
      .prepare("SELECT * FROM tasks")
      .all() as unknown as TaskRow[];
    return rows.map(rowToTaskStats);
  });
}

export function getTask(
  repoSlug: string,
  branch: string,
): TaskStats | undefined {
  return withDb((db) => {
    const row = db
      .prepare("SELECT * FROM tasks WHERE key = :key")
      .get({ key: taskKey(repoSlug, branch) }) as TaskRow | undefined;
    return row ? rowToTaskStats(row) : undefined;
  });
}
