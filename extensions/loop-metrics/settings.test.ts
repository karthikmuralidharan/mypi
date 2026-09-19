import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isEnabled, setEnabled } from "./settings.ts";

function withDataDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-metrics-settings-"));
  const prev = process.env.PI_LOOP_METRICS_DIR;
  process.env.PI_LOOP_METRICS_DIR = dir;
  try {
    fn(dir);
  } finally {
    process.env.PI_LOOP_METRICS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("isEnabled defaults to true when no settings file exists yet", () => {
  withDataDir(() => {
    assert.equal(isEnabled(), true);
  });
});

test("setEnabled(false) then isEnabled() reflects the change", () => {
  withDataDir(() => {
    setEnabled(false);
    assert.equal(isEnabled(), false);
  });
});

test("setEnabled(true) re-enables after being disabled", () => {
  withDataDir(() => {
    setEnabled(false);
    setEnabled(true);
    assert.equal(isEnabled(), true);
  });
});

test("isEnabled tolerates a corrupt settings file by defaulting to true", () => {
  withDataDir((dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), "not json");
    assert.equal(isEnabled(), true);
  });
});
