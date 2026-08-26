import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  getTask,
  isStageTransition,
  listTasks,
  mergeTask,
  recordTurn,
} from "./store.ts";
import { zeroCost, zeroDelta, zeroTokens, zeroToolCalls } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "record-once.ts");

function withDataDir(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> | void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-metrics-store-"));
  const prev = process.env.PI_LOOP_METRICS_DIR;
  process.env.PI_LOOP_METRICS_DIR = dir;
  const cleanup = () => {
    process.env.PI_LOOP_METRICS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const result = fn(dir);
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
}

// ---- mergeTask: pure, no filesystem ----

test("mergeTask creates a fresh task on the first turn", () => {
  const merged = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "feat/x",
      cwd: "/tmp/x",
      delta: { ...zeroDelta(), durationMs: 500 },
      stageBucket: "implementing",
    },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(merged.turns, 1);
  assert.equal(merged.durationMs, 500);
  assert.equal(merged.firstSeenIso, "2026-01-01T00:00:00.000Z");
  assert.equal(merged.lastActiveIso, "2026-01-01T00:00:00.000Z");
});

test("mergeTask accumulates duration, turns, tokens, cost, and tool calls additively", () => {
  const first = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "feat/x",
      cwd: "/tmp/x",
      delta: {
        durationMs: 100,
        tokens: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15,
        },
        cost: {
          input: 0.1,
          output: 0.05,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.15,
        },
        toolCalls: { total: 2, byName: { read: 2 } },
      },
      stageBucket: "implementing",
    },
    "2026-01-01T00:00:00.000Z",
  );
  const second = mergeTask(
    first,
    {
      repoSlug: "o/r",
      branch: "feat/x",
      cwd: "/tmp/x",
      delta: {
        durationMs: 200,
        tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, total: 4 },
        cost: {
          input: 0.03,
          output: 0.01,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.04,
        },
        toolCalls: { total: 1, byName: { edit: 1 } },
      },
      stageBucket: "implementing",
    },
    "2026-01-01T00:01:00.000Z",
  );
  assert.equal(second.turns, 2);
  assert.equal(second.durationMs, 300);
  assert.equal(second.tokens.total, 19);
  assert.equal(second.cost.total, 0.19);
  assert.equal(second.toolCalls.total, 3);
  assert.deepEqual(second.toolCalls.byName, { read: 2, edit: 1 });
  assert.equal(second.firstSeenIso, "2026-01-01T00:00:00.000Z"); // preserved, not overwritten
  assert.equal(second.lastActiveIso, "2026-01-01T00:01:00.000Z");
});

test("mergeTask merges byName counts for the same tool across turns", () => {
  const first = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: { ...zeroDelta(), toolCalls: { total: 3, byName: { read: 3 } } },
      stageBucket: "implementing",
    },
    "t0",
  );
  const second = mergeTask(
    first,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: { ...zeroDelta(), toolCalls: { total: 2, byName: { read: 2 } } },
      stageBucket: "implementing",
    },
    "t1",
  );
  assert.deepEqual(second.toolCalls.byName, { read: 5 });
});

test("mergeTask keeps jiraKey once known, even if a later turn omits it", () => {
  const first = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: zeroDelta(),
      stageBucket: "implementing",
      jiraKey: "SWONE-1",
    },
    "t0",
  );
  assert.equal(first.jiraKey, "SWONE-1");
  const second = mergeTask(
    first,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: zeroDelta(),
      stageBucket: "implementing",
    },
    "t1",
  );
  assert.equal(
    second.jiraKey,
    "SWONE-1",
    "a later turn without jiraKey must not erase the known one",
  );
});

test("mergeTask overwrites jiraKey when a newer value is provided", () => {
  const first = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: zeroDelta(),
      stageBucket: "implementing",
      jiraKey: "SWONE-1",
    },
    "t0",
  );
  const second = mergeTask(
    first,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: zeroDelta(),
      stageBucket: "shipping",
      jiraKey: "SWONE-2",
    },
    "t1",
  );
  assert.equal(second.jiraKey, "SWONE-2");
});

test("mergeTask accumulates stageBreakdown per bucket independently", () => {
  const first = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: {
        ...zeroDelta(),
        durationMs: 100,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
      stageBucket: "spec_plan",
    },
    "t0",
  );
  const second = mergeTask(
    first,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: {
        ...zeroDelta(),
        durationMs: 50,
        tokens: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, total: 6 },
      },
      stageBucket: "implementing",
    },
    "t1",
  );
  const third = mergeTask(
    second,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: {
        ...zeroDelta(),
        durationMs: 25,
        tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10 },
      },
      stageBucket: "implementing",
    },
    "t2",
  );
  // spec_plan: one turn, untouched by the later implementing-bucket turns.
  assert.equal(third.stageBreakdown.spec_plan?.turns, 1);
  assert.equal(third.stageBreakdown.spec_plan?.durationMs, 100);
  assert.equal(third.stageBreakdown.spec_plan?.tokens.total, 2);
  // implementing: two turns, summed.
  assert.equal(third.stageBreakdown.implementing?.turns, 2);
  assert.equal(third.stageBreakdown.implementing?.durationMs, 75);
  assert.equal(third.stageBreakdown.implementing?.tokens.total, 16);
  // shipping: never touched, absent rather than a zeroed placeholder.
  assert.equal(third.stageBreakdown.shipping, undefined);
  // Total across the task still sums every turn, same as before this change.
  assert.equal(third.turns, 3);
  assert.equal(third.durationMs, 175);
});

// ---- SQLite-backed store: real filesystem, real DB file ----

test("recordTurn then listTasks/getTask round-trips correctly", () => {
  withDataDir(() => {
    recordTurn({
      repoSlug: "o/r",
      branch: "feat/a",
      cwd: "/tmp/a",
      delta: { ...zeroDelta(), durationMs: 42 },
      stageBucket: "implementing",
      jiraKey: "SWONE-7",
    });
    const task = getTask("o/r", "feat/a");
    assert.ok(task);
    assert.equal(task?.durationMs, 42);
    assert.equal(task?.turns, 1);
    assert.equal(task?.jiraKey, "SWONE-7");
    assert.equal(task?.stageBreakdown.implementing?.turns, 1);
    assert.equal(listTasks().length, 1);
  });
});

test("recordTurn keeps separate branches as separate tasks", () => {
  withDataDir(() => {
    recordTurn({
      repoSlug: "o/r",
      branch: "feat/a",
      cwd: "/tmp/a",
      delta: zeroDelta(),
      stageBucket: "implementing",
    });
    recordTurn({
      repoSlug: "o/r",
      branch: "feat/b",
      cwd: "/tmp/b",
      delta: zeroDelta(),
      stageBucket: "implementing",
    });
    assert.equal(listTasks().length, 2);
  });
});

test("listTasks on an empty/missing store returns an empty array, never throws", () => {
  withDataDir((dir) => {
    assert.deepEqual(listTasks(), []);
    assert.equal(fs.existsSync(path.join(dir, "tasks.db")), true); // schema created on first touch
  });
});

test("recordTurn survives a corrupt tool_calls_by_name JSON blob on read", () => {
  withDataDir(() => {
    recordTurn({
      repoSlug: "o/r",
      branch: "feat/a",
      cwd: "/tmp/a",
      delta: zeroDelta(),
      stageBucket: "implementing",
    });
    // Directly corrupt the byName column to prove rowToTaskStats degrades gracefully.
    const db = new DatabaseSync(
      path.join(process.env.PI_LOOP_METRICS_DIR ?? "", "tasks.db"),
    );
    db.prepare(
      "UPDATE tasks SET tool_calls_by_name = 'not json' WHERE key = ?",
    ).run("o/r::feat/a");
    db.close();
    const task = getTask("o/r", "feat/a");
    assert.deepEqual(task?.toolCalls.byName, {});
  });
});

test("recordTurn survives a corrupt stage_breakdown JSON blob on read", () => {
  withDataDir(() => {
    recordTurn({
      repoSlug: "o/r",
      branch: "feat/a",
      cwd: "/tmp/a",
      delta: zeroDelta(),
      stageBucket: "implementing",
    });
    const db = new DatabaseSync(
      path.join(process.env.PI_LOOP_METRICS_DIR ?? "", "tasks.db"),
    );
    db.prepare(
      "UPDATE tasks SET stage_breakdown = 'not json' WHERE key = ?",
    ).run("o/r::feat/a");
    db.close();
    const task = getTask("o/r", "feat/a");
    assert.deepEqual(task?.stageBreakdown, {});
  });
});

// ---- isStageTransition / recordTurn's transitioned flag ----

test("isStageTransition is false for the first-ever turn (nothing to transition from)", () => {
  assert.equal(isStageTransition(undefined, "spec_plan"), false);
});

test("isStageTransition is false when the bucket is unchanged", () => {
  const first = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: zeroDelta(),
      stageBucket: "implementing",
    },
    "t0",
  );
  assert.equal(isStageTransition(first, "implementing"), false);
});

test("isStageTransition is true when the bucket differs from the last recorded one", () => {
  const first = mergeTask(
    undefined,
    {
      repoSlug: "o/r",
      branch: "b",
      cwd: "/x",
      delta: zeroDelta(),
      stageBucket: "implementing",
    },
    "t0",
  );
  assert.equal(isStageTransition(first, "shipping"), true);
});

test("recordTurn reports transitioned:false on the first turn and transitioned:true when the bucket changes", () => {
  withDataDir(() => {
    const r1 = recordTurn({
      repoSlug: "o/r",
      branch: "feat/a",
      cwd: "/tmp/a",
      delta: zeroDelta(),
      stageBucket: "spec_plan",
    });
    assert.equal(r1.transitioned, false);

    const r2 = recordTurn({
      repoSlug: "o/r",
      branch: "feat/a",
      cwd: "/tmp/a",
      delta: zeroDelta(),
      stageBucket: "spec_plan",
    });
    assert.equal(
      r2.transitioned,
      false,
      "same bucket again is not a transition",
    );

    const r3 = recordTurn({
      repoSlug: "o/r",
      branch: "feat/a",
      cwd: "/tmp/a",
      delta: zeroDelta(),
      stageBucket: "implementing",
    });
    assert.equal(r3.transitioned, true);
    assert.equal(r3.task.lastStageBucket, "implementing");
  });
});

// ---- The load-bearing test: real cross-process concurrency ----

test("recordTurn serializes writes across real concurrent OS processes with no lost updates", {
  timeout: 30_000,
}, async () => {
  await withDataDir(async () => {
    const dir = process.env.PI_LOOP_METRICS_DIR as string;
    const N = 20;
    const runs = Array.from(
      { length: N },
      (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [FIXTURE, "conc/repo", "feat/concurrent", `/tmp/w${i}`, "100"],
            {
              env: { ...process.env, PI_LOOP_METRICS_DIR: dir },
              stdio: "pipe",
            },
          );
          let stderr = "";
          child.stderr.on("data", (d) => {
            stderr += d.toString();
          });
          child.on("exit", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`worker ${i} exit ${code}: ${stderr}`)),
          );
        }),
    );
    await Promise.all(runs);

    const task = getTask("conc/repo", "feat/concurrent");
    assert.ok(task, "task should exist after concurrent writes");
    assert.equal(
      task?.turns,
      N,
      "every concurrent recordTurn call must be counted, none lost to a lost update",
    );
    assert.equal(task?.durationMs, N * 100);
    assert.equal(task?.tokens.total, N * 2);
    assert.equal(task?.toolCalls.total, N);
    assert.equal(task?.toolCalls.byName.read, N);
  });
});

// Guard the zero-value helpers directly — trivial, but they are the seed
// every delta accumulation starts from, so a wrong zero silently corrupts everything downstream.
test("zero* helpers produce genuinely zeroed structures", () => {
  assert.deepEqual(zeroTokens(), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.deepEqual(zeroCost(), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.deepEqual(zeroToolCalls(), { total: 0, byName: {} });
});
