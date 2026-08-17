/**
 * Tests for the user configuration layer.
 *
 * This layer exists because upstream @piex-dev/dap dropped oh-my-pi's config
 * merging entirely, so adding a language or fixing a wrong command meant editing
 * node_modules. These tests pin the precedence order and, more importantly, the
 * failure behaviour: a broken config file must degrade to defaults rather than
 * disable debugging.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
	clearAdapterConfigCache,
	extractAdapterMap,
	getAdapterConfigs,
	mergeAdapterConfigs,
	resolveAdapter,
} from "./config";
import type { DapAdapterConfig } from "./types";

const tmpDirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "dap-cfgtest-"));
	tmpDirs.push(d);
	return d;
}

afterEach(() => {
	delete process.env.PI_DAP_CONFIG;
	clearAdapterConfigCache();
	for (const d of tmpDirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/** Load configs with the user path redirected to `userFile` and cwd at `cwd`. */
function load(cwd: string, userFile: string) {
	process.env.PI_DAP_CONFIG = userFile;
	clearAdapterConfigCache();
	return getAdapterConfigs(cwd);
}

const base: Record<string, DapAdapterConfig> = {
	demo: {
		command: "orig",
		args: ["a"],
		languages: ["python"],
		fileTypes: [".py"],
		rootMarkers: [],
		launchDefaults: { stopOnEntry: true },
		attachDefaults: {},
		acceptsDirectoryProgram: false,
	},
};

describe("extractAdapterMap", () => {
	test("accepts the { adapters: {...} } shape", () => {
		expect(extractAdapterMap({ adapters: { x: { command: "c" } } })).toEqual({
			x: { command: "c" },
		});
	});

	test("accepts a bare adapter map", () => {
		expect(extractAdapterMap({ x: { command: "c" } })).toEqual({
			x: { command: "c" },
		});
	});

	test("returns empty for non-objects rather than throwing", () => {
		// isRecord excludes null and arrays, so every one of these yields {}.
		for (const v of [null, 42, "str", undefined, [], [{ command: "c" }]]) {
			expect(extractAdapterMap(v)).toEqual({});
		}
	});
});

describe("mergeAdapterConfigs", () => {
	test("patches one field and preserves the rest", () => {
		// The whole point of shallow merge: override `command` without having to
		// restate languages/fileTypes/launchDefaults.
		const out = mergeAdapterConfigs(base, { demo: { command: "patched" } });
		expect(out.demo.command).toBe("patched");
		expect(out.demo.languages).toEqual(["python"]);
		expect(out.demo.launchDefaults).toEqual({ stopOnEntry: true });
	});

	test("defines a brand-new adapter", () => {
		const out = mergeAdapterConfigs(base, {
			fresh: { command: "newcmd", languages: ["go"] },
		});
		expect(out.fresh?.command).toBe("newcmd");
		expect(out.demo).toBeDefined(); // base survives
	});

	test("skips a new adapter with no command instead of throwing", () => {
		const out = mergeAdapterConfigs(base, { broken: { languages: ["go"] } });
		expect(out.broken).toBeUndefined();
		expect(out.demo.command).toBe("orig");
	});

	test("one invalid entry does not discard the valid ones", () => {
		// A typo in a single adapter must not disable the whole debugger.
		const out = mergeAdapterConfigs(base, {
			broken: { nope: true },
			good: { command: "ok" },
		});
		expect(out.good?.command).toBe("ok");
		expect(out.broken).toBeUndefined();
	});

	test("ignores non-object patches", () => {
		const out = mergeAdapterConfigs(base, { demo: "nonsense", other: 42 });
		expect(out.demo.command).toBe("orig");
		expect(out.other).toBeUndefined();
	});

	test("does not mutate the base map", () => {
		mergeAdapterConfigs(base, { demo: { command: "patched" } });
		expect(base.demo.command).toBe("orig");
	});

	test("a patch can change connectMode", () => {
		const out = mergeAdapterConfigs(base, { demo: { connectMode: "tcp" } });
		expect(out.demo.connectMode).toBe("tcp");
	});
});

describe("file discovery and precedence", () => {
	test("user config overrides a bundled default", () => {
		const dir = tmp();
		const userFile = path.join(dir, "user.json");
		fs.writeFileSync(userFile, JSON.stringify({ dlv: { command: "user-dlv" } }));
		expect(load(dir, userFile).dlv?.command).toBe("user-dlv");
	});

	test("project config overrides user config", () => {
		const dir = tmp();
		const userFile = path.join(dir, "user.json");
		fs.writeFileSync(userFile, JSON.stringify({ dlv: { command: "user-dlv" } }));
		fs.writeFileSync(
			path.join(dir, ".dap.json"),
			JSON.stringify({ dlv: { command: "proj-dlv" } }),
		);
		expect(load(dir, userFile).dlv?.command).toBe("proj-dlv");
	});

	test("dap.json is read as well as .dap.json", () => {
		const dir = tmp();
		fs.writeFileSync(
			path.join(dir, "dap.json"),
			JSON.stringify({ dlv: { command: "plain" } }),
		);
		expect(load(dir, path.join(dir, "absent.json")).dlv?.command).toBe("plain");
	});

	test("a bundled adapter keeps its other fields when patched by file", () => {
		const dir = tmp();
		const userFile = path.join(dir, "user.json");
		fs.writeFileSync(userFile, JSON.stringify({ dlv: { command: "user-dlv" } }));
		const dlv = load(dir, userFile).dlv;
		expect(dlv?.connectMode).toBe("socket"); // from defaults.json, not the patch
	});

	test("malformed JSON is ignored and defaults survive", () => {
		// The critical failure mode: a trailing comma must not break debugging.
		const dir = tmp();
		const userFile = path.join(dir, "user.json");
		fs.writeFileSync(userFile, '{ "dlv": { "command": "x" },, }');
		const cfg = load(dir, userFile);
		expect(cfg.dlv?.command).toBe("dlv"); // bundled default intact
		expect(Object.keys(cfg).length).toBeGreaterThan(5);
	});

	test("absent config files are not an error", () => {
		const dir = tmp();
		expect(
			Object.keys(load(dir, path.join(dir, "nope.json"))).length,
		).toBeGreaterThan(5);
	});

	test("a user-defined adapter is resolvable when its command exists", () => {
		const dir = tmp();
		const userFile = path.join(dir, "user.json");
		// process.execPath always exists, so resolution should succeed.
		fs.writeFileSync(
			userFile,
			JSON.stringify({
				mylang: { command: process.execPath, fileTypes: [".xyz"] },
			}),
		);
		process.env.PI_DAP_CONFIG = userFile;
		clearAdapterConfigCache();
		const resolved = resolveAdapter("mylang", dir);
		expect(resolved?.resolvedCommand).toBe(process.execPath);
		expect(resolved?.fileTypes).toEqual([".xyz"]);
	});
});

describe("cache", () => {
	test("clearAdapterConfigCache picks up a changed file", () => {
		const dir = tmp();
		const userFile = path.join(dir, "user.json");
		fs.writeFileSync(userFile, JSON.stringify({ dlv: { command: "first" } }));
		expect(load(dir, userFile).dlv?.command).toBe("first");
		fs.writeFileSync(userFile, JSON.stringify({ dlv: { command: "second" } }));
		expect(load(dir, userFile).dlv?.command).toBe("second");
	});

	test("returns a copy so callers cannot corrupt the cache", () => {
		const dir = tmp();
		const userFile = path.join(dir, "absent.json");
		const first = load(dir, userFile);
		delete first.dlv;
		expect(load(dir, userFile).dlv).toBeDefined();
	});
});
