/**
 * Reader for `.loop/state/<branch>.json`, written by the `loop` skill's own
 * scripts (see common.sh's `state_set`/`state_set_json`) as a side effect of
 * work they already do: `gate-pass` records gate approval, `sync
 * create-issue`/`mirror-jira` record the issue and JIRA key, `sync
 * auto-status` records the PR number, `ship-gate` records its last clear
 * commit. This module only reads that file — it never writes to it, and it
 * makes no `gh`/JIRA calls itself, which is what makes it safe to call on
 * every turn (a local fs read, not a network round trip).
 *
 * File naming MUST match `state_file()` in common.sh exactly: a branch name
 * with "/" replaced by "__". Diverging from that here would silently read
 * the wrong file (or none), so this is not reimplemented independently.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Walks up from `startCwd` looking for a `.loop/config.json`, mirroring
 * common.sh's own `find_config_dir` exactly (a pure directory walk, not a
 * `git rev-parse` call) so this stays correct across git worktrees -- each
 * worktree's `.loop/` is its own untracked directory, not shared with the
 * main checkout, and a task's stored `cwd` is the only reliable anchor for
 * finding the right one. Returns the `.loop` directory path, or `undefined`
 * if none is found by the filesystem root.
 */
export function findLoopDir(startCwd: string): string | undefined {
 let dir = path.resolve(startCwd);
 while (true) {
  if (fs.existsSync(path.join(dir, ".loop", "config.json"))) {
   return path.join(dir, ".loop");
  }
  const parent = path.dirname(dir);
  if (parent === dir) return undefined;
  dir = parent;
 }
}

export interface GateInfo {
 approved: boolean;
 at?: string;
 note?: string;
}

export interface LoopState {
 gate1?: GateInfo;
 gate2?: GateInfo;
 issue?: string;
 jira?: string;
 pr?: string;
 lastShipGatePassCommit?: string;
}

/** Mirrors common.sh's state_file(): "/" in a branch name becomes "__". */
export function stateFileName(branch: string): string {
 return `${branch.replace(/\//g, "__")}.json`;
}

/**
 * Reads `.loop/state/<branch>.json` under `loopDirPath` (the repo's `.loop`
 * directory — see scope.ts's `loopDir()`). Returns `undefined` when the file
 * is missing or unparsable: a branch that has never run `gate-pass`/`sync`/
 * `ship-gate` yet simply has no state file, which is the common, expected
 * case for a task in Stage 0-2, not an error condition to surface.
 */
export function readLoopState(
 loopDirPath: string,
 branch: string,
): LoopState | undefined {
 const file = path.join(loopDirPath, "state", stateFileName(branch));
 try {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object") return parsed as LoopState;
  return undefined;
 } catch {
  return undefined;
 }
}

export type StageBucket = "spec_plan" | "implementing" | "shipping";

export const STAGE_BUCKETS: readonly StageBucket[] = [
 "spec_plan",
 "implementing",
 "shipping",
] as const;

export const STAGE_BUCKET_LABELS: Record<StageBucket, string> = {
 spec_plan: "spec/plan",
 implementing: "implementing",
 shipping: "shipping",
};

/**
 * Coarse, LOCAL-ONLY stage bucket for accounting purposes — three buckets,
 * derived purely from what `.loop/state/<branch>.json` already records, with
 * no `gh` call. This is deliberately less precise than `stage.ts`'s live,
 * GitHub-derived `StageInfo` label (which distinguishes CI-failing/
 * review-pending/ship-gate-clear once a PR exists): that precision needs a
 * network round trip, which is fine once per dashboard render but not once
 * per turn. Three buckets, computed for free on every turn, is the right
 * trade for bucketing *historical* token/cost accounting; the dashboard's
 * live stage label still calls `resolveStage()` for the fine-grained view.
 *
 *   no `.issue`                -> "spec_plan"    (loop Stage 0-4, pre-issue)
 *   `.issue` set, no `.pr`     -> "implementing"  (loop Stage 5-7)
 *   `.pr` set                  -> "shipping"       (loop Stage 8-10, wins even
 *                                  over a missing `.issue` -- a real PR is
 *                                  stronger evidence of progress than an
 *                                  absent issue, though this combination
 *                                  should not occur in normal /loop use)
 */
export function localStageBucket(state: LoopState | undefined): StageBucket {
 if (state?.pr) return "shipping";
 if (!state?.issue) return "spec_plan";
 return "implementing";
}
