import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isLoopRepo } from "./scope.ts";

test("isLoopRepo is true when .loop/config.json exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-metrics-scope-"));
  try {
    fs.mkdirSync(path.join(dir, ".loop"));
    fs.writeFileSync(path.join(dir, ".loop", "config.json"), "{}");
    assert.equal(isLoopRepo(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLoopRepo is false with no .loop directory at all", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-metrics-scope-"));
  try {
    assert.equal(isLoopRepo(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLoopRepo is false when .loop exists but config.json does not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-metrics-scope-"));
  try {
    fs.mkdirSync(path.join(dir, ".loop"));
    assert.equal(isLoopRepo(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLoopRepo is false for a nonexistent path", () => {
  assert.equal(isLoopRepo("/definitely/does/not/exist/anywhere"), false);
});
