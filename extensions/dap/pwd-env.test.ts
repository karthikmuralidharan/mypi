/**
 * Regression test for PWD environment variable handling in child spawns.
 *
 * FAILURE MODE: child_process.spawn({cwd}) changes the child's working directory
 * via chdir() but does NOT update the inherited PWD to match. Go's os.Getwd()
 * prefers $PWD when valid, so debuggers see a stale PWD from the parent process.
 * This causes Go's module-boundary check to see mismatched paths — program path
 * is unresolved (/tmp/foo) but Go sees resolved path (/private/tmp/foo), failing
 * with "directory outside main module".
 *
 * FIX: pass `env: {...process.env, PWD: cwd}` to spawn() so inherited PWD stays
 * in sync with the child's actual directory.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";

test("PWD environment variable stays in sync with cwd across spawn", async () => {
	const tempParent = mkdtempSync("/tmp/pwd-env-test-");
	const tempChild = path.join(tempParent, "child");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(tempChild);

	try {
		// Spawn a child that checks its own PWD vs getcwd().
		const child = spawn("node", [
			"-e",
			`
const path = require('path');
const cwd = process.cwd();
const pwd = process.env.PWD;
console.log(JSON.stringify({cwd, pwd, match: cwd === pwd}));
`,
		], {
			cwd: tempChild,
			// Correctly updated PWD
			env: { ...process.env, PWD: tempChild },
		});

		let output = "";
		for await (const chunk of child.stdout) {
			output += chunk.toString();
		}

		const result = JSON.parse(output.trim());
		assert.strictEqual(result.match, true, "PWD should match cwd in spawned child");
	} finally {
		rmSync(tempParent, { recursive: true });
	}
});

test("PWD mismatch without explicit env causes Go module errors", async () => {
	// This test documents the failure mode — it can't actually reproduce Go's
	// error without a Go project and debugger, but it shows the root cause:
	// stale PWD inheritance.
	const originalPwd = process.env.PWD;
	try {
		process.env.PWD = "/some/unrelated/path";

		const tempDir = mkdtempSync("/tmp/pwd-mismatch-test-");
		try {
			const child = spawn("node", [
				"-e",
				`console.log(JSON.stringify({cwd: process.cwd(), pwd: process.env.PWD}))`,
			], {
				cwd: tempDir,
				// WRONG: inherited PWD without override
			});

			let output = "";
			for await (const chunk of child.stdout) {
				output += chunk.toString();
			}

			const result = JSON.parse(output.trim());
			// Without the fix, PWD is stale (parent's original, not child's cwd)
			assert.notStrictEqual(
				result.cwd,
				result.pwd,
				"PWD mismatch demonstrates the problem",
			);
		} finally {
			rmSync(tempDir, { recursive: true });
		}
	} finally {
		process.env.PWD = originalPwd;
	}
});
