/**
 * Scope gate: only track tasks inside a repo that `/loop setup` has
 * initialized. `.loop/config.json` is written by that command (see the
 * `loop` skill's SKILL.md, "Prerequisites") and is the only reliable signal
 * that a repo is loop-managed — there is no other marker.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function isLoopRepo(repoRoot: string): boolean {
	return fs.existsSync(path.join(repoRoot, ".loop", "config.json"));
}

/**
 * Get the .loop directory for the current repo.
 *
 * Throws if the current working directory is not in a loop-managed repo.
 */
export function loopDir(): string {
	const repoRoot = getRepoRoot();
	if (!isLoopRepo(repoRoot)) {
		throw new Error(
			`Not in a loop-managed repo. Initialize with /loop setup or create ${path.join(repoRoot, ".loop", "config.json")}`,
		);
	}
	return path.join(repoRoot, ".loop");
}

/**
 * Check if the current working directory is in a loop-managed repo.
 */
export function inLoopRepo(): boolean {
	try {
		const repoRoot = getRepoRoot();
		return isLoopRepo(repoRoot);
	} catch {
		return false;
	}
}

/**
 * Get the git repository root for the current working directory.
 *
 * Throws if not in a git repo.
 */
export function getRepoRoot(): string {
	const { execSync } = require("node:child_process");
	try {
		return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
	} catch (e) {
		throw new Error(`Not in a git repository: ${String(e).split("\n")[0]}`);
	}
}
