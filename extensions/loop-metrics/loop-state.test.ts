import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  findLoopDir,
  localStageBucket,
  readLoopState,
  stateFileName,
} from "./loop-state.ts";

test("stateFileName mirrors common.sh's state_file(): slashes become __", () => {
  assert.equal(stateFileName("feat/my-thing"), "feat__my-thing.json");
  assert.equal(stateFileName("main"), "main.json");
  assert.equal(stateFileName("a/b/c"), "a__b__c.json");
});

test("readLoopState returns undefined when the state dir doesn't exist at all", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-test-"));
  assert.equal(readLoopState(path.join(dir, ".loop"), "feat/x"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readLoopState returns undefined for a missing branch file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-test-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  assert.equal(readLoopState(dir, "feat/x"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readLoopState returns undefined for unparsable JSON, not a throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-test-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state", "feat__x.json"), "{not json");
  assert.equal(readLoopState(dir, "feat/x"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readLoopState round-trips a real state file written the way common.sh writes it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-test-"));
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const content = {
    gate1: { approved: true, at: "2026-01-01T00:00:00Z", note: "plan ok" },
    gate2: { approved: true, at: "2026-01-02T00:00:00Z" },
    issue: "#42",
    jira: "SWONE-99",
    pr: "7",
    lastShipGatePassCommit: "abc123",
  };
  fs.writeFileSync(
    path.join(dir, "state", "feat__my-thing.json"),
    JSON.stringify(content),
  );
  const state = readLoopState(dir, "feat/my-thing");
  assert.deepEqual(state, content);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("localStageBucket: no issue -> spec_plan", () => {
  assert.equal(localStageBucket(undefined), "spec_plan");
  assert.equal(localStageBucket({}), "spec_plan");
  assert.equal(localStageBucket({ gate1: { approved: true } }), "spec_plan");
});

test("localStageBucket: issue but no pr -> implementing", () => {
  assert.equal(localStageBucket({ issue: "#1" }), "implementing");
  assert.equal(localStageBucket({ issue: "#1", jira: "SP-1" }), "implementing");
});

test("localStageBucket: pr set -> shipping, regardless of issue", () => {
  assert.equal(localStageBucket({ issue: "#1", pr: "9" }), "shipping");
  // Defensive: a pr without a recorded issue shouldn't happen in practice
  // (sync bootstrap always creates the issue first), but if it did, the pr
  // signal should still win -- there is definitely a PR to look at.
  assert.equal(localStageBucket({ pr: "9" }), "shipping");
});

// ---- findLoopDir: pure directory walk, no git subprocess ----

test("findLoopDir finds .loop/ at the exact starting directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-test-"));
  fs.mkdirSync(path.join(dir, ".loop"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".loop", "config.json"), "{}");
  assert.equal(findLoopDir(dir), path.join(dir, ".loop"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findLoopDir walks up from a nested subdirectory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-test-"));
  fs.mkdirSync(path.join(dir, ".loop"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".loop", "config.json"), "{}");
  const nested = path.join(dir, "src", "deep", "nested");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findLoopDir(nested), path.join(dir, ".loop"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findLoopDir returns undefined when no .loop/config.json exists anywhere up the tree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-test-"));
  const nested = path.join(dir, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findLoopDir(nested), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
