import assert from "node:assert/strict";
import { test } from "node:test";
import {
  humanizeCost,
  humanizeCount,
  humanizeDuration,
  relativeTime,
} from "./format.ts";

test("humanizeDuration", () => {
  assert.equal(humanizeDuration(0), "0s");
  assert.equal(humanizeDuration(45_000), "45s");
  assert.equal(humanizeDuration(90_000), "1m 30s");
  assert.equal(humanizeDuration(60_000), "1m");
  assert.equal(humanizeDuration(3_600_000), "1h");
  assert.equal(humanizeDuration(3_600_000 + 12 * 60_000), "1h 12m");
  assert.equal(humanizeDuration(-5), "0s");
  assert.equal(humanizeDuration(Number.NaN), "0s");
});

test("humanizeCount", () => {
  assert.equal(humanizeCount(0), "0");
  assert.equal(humanizeCount(84), "84");
  assert.equal(humanizeCount(999), "999");
  assert.equal(humanizeCount(1000), "1K");
  assert.equal(humanizeCount(1234), "1.2K");
  assert.equal(humanizeCount(1_000_000), "1M");
  assert.equal(humanizeCount(2_500_000), "2.5M");
});

test("humanizeCost", () => {
  assert.equal(humanizeCost(0), "$0.00");
  assert.equal(humanizeCost(1.2345), "$1.23");
  assert.equal(humanizeCost(0.001), "$0.00");
});

test("relativeTime", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  assert.equal(relativeTime("2026-08-17T11:59:30.000Z", now), "just now");
  assert.equal(relativeTime("2026-08-17T11:58:00.000Z", now), "2m ago");
  assert.equal(relativeTime("not-a-date", now), "unknown");
});
