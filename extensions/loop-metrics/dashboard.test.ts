import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDashboardItems, formatTaskItem, sortTasks } from "./dashboard.ts";
import type { StageInfo } from "./stage.ts";
import { taskKey, type TaskStats, zeroDelta } from "./types.ts";

function makeTask(overrides: Partial<TaskStats>): TaskStats {
  const delta = zeroDelta();
  return {
    repoSlug: "o/r",
    branch: "feat/x",
    cwd: "/tmp/x",
    firstSeenIso: "2026-01-01T00:00:00.000Z",
    lastActiveIso: "2026-01-01T00:00:00.000Z",
    durationMs: 0,
    turns: 0,
    toolCalls: delta.toolCalls,
    tokens: delta.tokens,
    cost: delta.cost,
    ...overrides,
  };
}

test("sortTasks orders most-recently-active first", () => {
  const older = makeTask({
    branch: "a",
    lastActiveIso: "2026-01-01T00:00:00.000Z",
  });
  const newer = makeTask({
    branch: "b",
    lastActiveIso: "2026-01-02T00:00:00.000Z",
  });
  const sorted = sortTasks([older, newer]);
  assert.deepEqual(
    sorted.map((t) => t.branch),
    ["b", "a"],
  );
});

test("sortTasks does not mutate its input array", () => {
  const a = makeTask({
    branch: "a",
    lastActiveIso: "2026-01-01T00:00:00.000Z",
  });
  const b = makeTask({
    branch: "b",
    lastActiveIso: "2026-01-02T00:00:00.000Z",
  });
  const input = [a, b];
  sortTasks(input);
  assert.deepEqual(input, [a, b]); // original order preserved
});

test("formatTaskItem marks the current task and includes core metrics", () => {
  const task = makeTask({
    branch: "feat/x",
    durationMs: 90_000,
    turns: 3,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1234 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.5 },
    toolCalls: { total: 7, byName: {} },
  });
  const item = formatTaskItem(task, { isCurrent: true });
  assert.match(item.label, /^● /);
  assert.match(item.label, /feat\/x/);
  assert.match(item.description, /1m 30s/);
  assert.match(item.description, /3 turns/);
  assert.match(item.description, /1\.2K tok/);
  assert.match(item.description, /\$1\.50/);
  assert.match(item.description, /7 calls/);
});

test("formatTaskItem does not mark a task as current when it isn't", () => {
  const item = formatTaskItem(makeTask({}), { isCurrent: false });
  assert.doesNotMatch(item.label, /^● /);
});

test("formatTaskItem includes stage label, checklist progress, and JIRA key when a stage is given", () => {
  const stage: StageInfo = {
    label: "PR open · ship-gate clear",
    checklist: { done: 2, total: 5 },
    jiraKey: "SP-9",
  };
  const item = formatTaskItem(makeTask({}), { stage });
  assert.match(item.description, /PR open · ship-gate clear/);
  assert.match(item.description, /2\/5 done/);
  assert.match(item.description, /SP-9/);
});

test("formatTaskItem shows a dash placeholder when no stage was resolved", () => {
  const item = formatTaskItem(makeTask({}), {});
  assert.match(item.description, /stage: —/);
});

test("formatTaskItem surfaces the stage's url on the item for the open-in-browser action", () => {
  const stage: StageInfo = { label: "merged", url: "https://x/pr/1" };
  const item = formatTaskItem(makeTask({}), { stage });
  assert.equal(item.url, "https://x/pr/1");
});

test("buildDashboardItems wires stage lookups and current-task detection by key, not by object identity", () => {
  const a = makeTask({
    repoSlug: "o/r",
    branch: "a",
    lastActiveIso: "2026-01-02T00:00:00.000Z",
  });
  const b = makeTask({
    repoSlug: "o/r",
    branch: "b",
    lastActiveIso: "2026-01-01T00:00:00.000Z",
  });
  const stages = new Map<string, StageInfo>([
    [taskKey("o/r", "b"), { label: "merged" }],
  ]);
  const items = buildDashboardItems([a, b], {
    stages,
    currentKey: taskKey("o/r", "a"),
  });

  assert.equal(items.length, 2);
  assert.match(items[0].label, /^● /); // a is current and sorts first (more recent)
  assert.match(items[1].label, /^(?!● )/); // b is not current
  assert.match(items[1].description, /merged/); // b's stage was found via its own key
  assert.doesNotMatch(items[0].description, /merged/); // a has no stage entry
});

test("buildDashboardItems on an empty task list returns an empty list", () => {
  assert.deepEqual(buildDashboardItems([], {}), []);
});
