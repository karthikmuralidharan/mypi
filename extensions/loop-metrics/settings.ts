/**
 * Extension-level on/off switch for loop-metrics' turn tracking, independent
 * of any repo's `.loop/config.json` -- see index.ts's `/loop-metrics`
 * command. Persisted next to `tasks.db` so it survives restarts and applies
 * across every repo, not just the one active when it was toggled.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "./store.ts";

function settingsPath(): string {
  return path.join(dataDir(), "settings.json");
}

/** Defaults to enabled: no settings file yet, or an unreadable/corrupt one,
 * both mean "tracking has never been explicitly turned off." */
export function isEnabled(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return parsed?.enabled !== false;
  } catch {
    return true;
  }
}

export function setEnabled(enabled: boolean): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ enabled }, null, 2));
}
