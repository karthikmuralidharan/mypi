import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatRollupComment,
  parseIssueNumber,
  postRollup,
  type RunGh,
} from "./gh-rollup.ts";
import type { TaskStats } from "./types.ts";

function makeStats(overrides: Partial<TaskStats> = {}): TaskStats {
  return {
    repoSlug: "o/r",
    branch: "feat/x",
    cwd: "/tmp/x",
    firstSeenIso: "2026-01-01T00:00:00.000Z",
    lastActiveIso: "2026-01-01T00:00:00.000Z",
    durationMs: 90_000,
    turns: 5,
    toolCalls: { total: 10, byName: {} },
    tokens: {
      input: 100,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      total: 300,
    },
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    stageBreakdown: {},
    ...overrides,
  };
}

// ---- parseIssueNumber ----

test("parseIssueNumber parses sync.sh's '#42' format", () => {
  assert.equal(parseIssueNumber("#42"), 42);
});

test("parseIssueNumber also accepts a bare number string", () => {
  assert.equal(parseIssueNumber("42"), 42);
});

test("parseIssueNumber returns undefined for undefined, empty, or garbage input", () => {
  assert.equal(parseIssueNumber(undefined), undefined);
  assert.equal(parseIssueNumber(""), undefined);
  assert.equal(parseIssueNumber("not-a-number"), undefined);
  assert.equal(parseIssueNumber("#"), undefined);
});

// ---- formatRollupComment: pure, no gh call ----

test("formatRollupComment includes the marker and top-line totals", () => {
  const body = formatRollupComment(makeStats());
  assert.match(body, /^<!-- loop-metrics:v1 -->/);
  assert.match(body, /Turns: 5/);
  assert.match(body, /Tokens: 300/);
  assert.match(body, /\$0\.30/);
});

test("formatRollupComment's table includes only buckets with turns > 0", () => {
  const body = formatRollupComment(
    makeStats({
      stageBreakdown: {
        spec_plan: {
          stage: "spec_plan",
          turns: 2,
          durationMs: 100,
          tokens: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            total: 2,
          },
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.01,
          },
        },
        implementing: {
          stage: "implementing",
          turns: 0,
          durationMs: 0,
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    }),
  );
  assert.match(body, /spec\/plan/);
  assert.doesNotMatch(body, /\| implementing \|/);
  assert.doesNotMatch(body, /shipping/);
});

// ---- postRollup: find-or-create-and-update, with an injected fake gh ----

test("postRollup creates a new comment when no marker comment exists yet", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const runGh: RunGh = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[0] === "api") return ""; // no existing comments
    return "";
  };
  await postRollup("o/r", 42, makeStats(), { runGh });

  const createCall = calls.find((c) => c.args[0] === "issue");
  assert.ok(createCall, "should call `gh issue comment` to create");
  assert.deepEqual(createCall?.args, [
    "issue",
    "comment",
    "42",
    "--repo",
    "o/r",
    "--body-file",
    "-",
  ]);
  assert.match(createCall?.input ?? "", /loop-metrics:v1/);
  assert.equal(
    calls.some((c) => c.args.includes("PATCH")),
    false,
    "must not also try to PATCH when nothing existed",
  );
});

test("postRollup updates the existing marker comment in place, not a new one", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const runGh: RunGh = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      // Simulate --paginate -q streaming one JSON object per line, mixed
      // with an unrelated human comment that must be skipped.
      return [
        JSON.stringify({ id: 111, body: "just a human comment" }),
        JSON.stringify({
          id: 222,
          body: "<!-- loop-metrics:v1 -->\nold stats",
        }),
      ].join("\n");
    }
    return "";
  };
  await postRollup("o/r", 42, makeStats(), { runGh });

  const patchCall = calls.find((c) => c.args.includes("PATCH"));
  assert.ok(patchCall, "should PATCH the found comment");
  assert.ok(
    patchCall?.args.includes("repos/o/r/issues/comments/222"),
    "must target the marker comment's id, not the unrelated one",
  );
  const createCall = calls.find(
    (c) => c.args[0] === "issue" && c.args[1] === "comment",
  );
  assert.equal(createCall, undefined, "must not create a second comment");
});

test("postRollup swallows any gh failure -- auth, rate limit, deleted issue -- without throwing", async () => {
  const runGh: RunGh = async () => {
    throw new Error("gh: authentication required");
  };
  await assert.doesNotReject(() =>
    postRollup("o/r", 42, makeStats(), { runGh }),
  );
});

test("postRollup swallows a failure on the update/create call too, not just the lookup", async () => {
  const runGh: RunGh = async (args) => {
    if (args[0] === "api" && args[1]?.includes("/comments")) return "";
    throw new Error("gh: rate limited");
  };
  await assert.doesNotReject(() =>
    postRollup("o/r", 42, makeStats(), { runGh }),
  );
});
