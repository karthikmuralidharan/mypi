/**
 * Session lifecycle tests, driven through a real DAP handshake against
 * fixtures/fake-adapter.mjs.
 *
 * This was the largest coverage gap: session.ts holds the launch ordering, the
 * subscribe-before-send race that makes `continue` correct, and every failure
 * path. oh-my-pi spends ~1,398 lines here; @piex-dev/dap shipped none.
 *
 * Spawns a node fixture rather than a real debugger, so these are deterministic
 * and need no debugpy/dlv/js-debug. smoke.ts remains the complementary check
 * that the real adapters still speak the protocol.
 */

import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DapSessionManager } from "./session";
import type { DapResolvedAdapter } from "./types";

const FIXTURE = path.join(import.meta.dir, "fixtures", "fake-adapter.mjs");

function fakeAdapter(mode: string): DapResolvedAdapter {
	return {
		name: `fake-${mode}`,
		command: process.execPath,
		args: [FIXTURE],
		resolvedCommand: process.execPath,
		languages: ["python"],
		fileTypes: [".py"],
		rootMarkers: [],
		launchDefaults: { request: "launch", stopOnEntry: true },
		attachDefaults: { request: "attach" },
		connectMode: "stdio",
		acceptsDirectoryProgram: false,
	};
}

const live: DapSessionManager[] = [];
afterEach(async () => {
	// Never leak adapter processes between tests.
	for (const m of live.splice(0)) {
		await m.terminate(undefined, 2_000).catch(() => {});
	}
});

/**
 * The fixture takes its mode from the environment and DapClient.spawn inherits
 * process.env, so set it for the duration of the launch only.
 */
async function launch(
	mode: string,
	env: Record<string, string> = {},
	timeoutMs = 5_000,
) {
	const applied = { FAKE_DAP_MODE: mode, ...env };
	const prev = Object.fromEntries(
		Object.keys(applied).map((k) => [k, process.env[k]]),
	);
	Object.assign(process.env, applied);
	const mgr = new DapSessionManager();
	live.push(mgr);
	try {
		const summary = await mgr.launch(
			{ adapter: fakeAdapter(mode), program: "/fake/app.py", cwd: process.cwd() },
			undefined,
			timeoutMs,
		);
		return { mgr, summary };
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe("launch", () => {
	test("completes the handshake: stopped, capabilities, top frame, one session", async () => {
		const { mgr, summary } = await launch("normal");
		expect(summary.status).toBe("stopped");
		expect(summary.stopReason).toBe("entry"); // stopOnEntry
		expect(summary.frameName).toBe("main"); // #fetchTop ran a stackTrace
		expect(summary.line).toBe(10);
		expect(mgr.getCapabilities()?.supportsConfigurationDoneRequest).toBe(true);
		expect(mgr.listSessions()).toHaveLength(1);
	});

	test("works with an adapter lacking configurationDone support", async () => {
		expect((await launch("no-config-done")).summary.status).toBe("stopped");
	});

	test("falls back to running when the adapter never stops", async () => {
		const { summary } = await launch("no-stop", {}, 3_000);
		expect(["running", "configuring"]).toContain(summary.status);
	});
});

describe("launch failures", () => {
	test("surfaces adapter stderr when it exits during launch", async () => {
		await expect(launch("exit-on-launch", {}, 4_000)).rejects.toThrow(
			/simulated launch failure|exited/,
		);
	});

	test("rejects instead of hanging when initialize is never answered", async () => {
		await expect(launch("silent-init", {}, 800)).rejects.toThrow(
			/timed out|initialize/i,
		);
	});

	test("a failed launch leaves no session, so the next launch can proceed", async () => {
		// The one-session slot is hard: failing to dispose would wedge the manager.
		await expect(launch("exit-on-launch", {}, 4_000)).rejects.toThrow();
		const mgr = live[live.length - 1];
		expect(mgr.listSessions()).toHaveLength(0);
	});
});

describe("execution control", () => {
	test("continue resolves with the next stop, not the request ack", async () => {
		// Guards subscribe-before-send: a `stopped` event can arrive in the same
		// read as the continue response and would be lost if the waiter were
		// registered after the write.
		const { mgr } = await launch("normal");
		const o = await mgr.continue(undefined, 4_000);
		expect(o.state).toBe("stopped");
		expect(o.snapshot.stopReason).toBe("breakpoint");
		expect(o.timedOut).toBe(false);
	});

	test("repeated continues each observe their own stop", async () => {
		const { mgr } = await launch("normal");
		for (let i = 0; i < 3; i++) {
			expect((await mgr.continue(undefined, 4_000)).state, `iteration ${i}`).toBe(
				"stopped",
			);
		}
	});

	test("stepOver reports a step stop", async () => {
		const { mgr } = await launch("normal");
		expect((await mgr.stepOver(undefined, 4_000)).snapshot.stopReason).toBe(
			"step",
		);
	});

	test("pause on an already-stopped session returns immediately", async () => {
		// Exercises the early-return guard whose TS narrowing was unsound upstream.
		const { mgr } = await launch("normal");
		expect((await mgr.pause(undefined, 3_000)).status).toBe("stopped");
	});
});

describe("state inspection", () => {
	test("threads -> stackTrace -> scopes -> variables chain by reference", async () => {
		const { mgr } = await launch("normal");
		expect((await mgr.threads(undefined, 3_000)).threads[0]?.id).toBe(1);
		const st = await mgr.stackTrace(undefined, undefined, 3_000);
		expect(st.stackFrames.length).toBeGreaterThan(0);
		const sc = await mgr.scopes(st.stackFrames[0]?.id, undefined, 3_000);
		const ref = sc.scopes[0]?.variablesReference;
		expect(ref).toBe(2000);
		expect(
			(await mgr.variables(ref!, undefined, 3_000)).variables.length,
		).toBeGreaterThan(0);
	});

	test("stackTrace honours an explicit levels limit", async () => {
		const { mgr } = await launch("normal");
		expect((await mgr.stackTrace(1, undefined, 3_000)).stackFrames).toHaveLength(
			1,
		);
	});
});

describe("breakpoints", () => {
	test("set returns verified, remove re-sends the remaining set", async () => {
		const { mgr } = await launch("normal");
		const set = await mgr.setBreakpoint(
			"/fake/app.py",
			10,
			undefined,
			undefined,
			3_000,
		);
		expect(set.breakpoints[0]).toMatchObject({ verified: true, line: 10 });
		await mgr.setBreakpoint("/fake/app.py", 20, undefined, undefined, 3_000);
		const rm = await mgr.removeBreakpoint("/fake/app.py", 10, undefined, 3_000);
		expect(rm.breakpoints).toHaveLength(1);
	});
});

describe("output buffering", () => {
	test("captures output and bounds the buffer under heavy volume", async () => {
		const { mgr } = await launch("noisy", { FAKE_DAP_NOISY_LINES: "4000" });
		await Bun.sleep(400);
		const { snapshot, output } = mgr.getOutput();
		expect(output).toContain("line "); // events were captured
		// 4000 lines x ~90 bytes far exceeds the 128KB ring.
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(128 * 1024);
		expect(snapshot.outputTruncated).toBe(true);
	});
});

describe("teardown", () => {
	test("terminate clears the registry and a fresh launch then succeeds", async () => {
		const { mgr } = await launch("normal");
		expect(await mgr.terminate(undefined, 3_000)).not.toBeNull();
		expect(mgr.listSessions()).toHaveLength(0);
		expect((await launch("normal")).summary.status).toBe("stopped");
	});

	test("terminate with no session returns null rather than throwing", async () => {
		await expect(
			new DapSessionManager().terminate(undefined, 1_000),
		).resolves.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Multi-session (vscode-js-debug style) -- the startDebugging / child-session regression
// ---------------------------------------------------------------------------
//
// js-debug's `pwa-node` always launches a lightweight "parent" session that is
// a pure bootstrapper (dapDebugServer.js: its own `threads` request always
// answers `[]`). The real program lives in a SEPARATE session the server asks
// the client to create via a `startDebugging` reverse request -- a brand new
// TCP connection to the SAME port, self-identified via `__pendingTargetId` in
// its own launch/attach arguments. Found live against the real js-debug
// adapter (see session.ts's `#wireClient`); multi-session-adapter.mjs
// reproduces that exact protocol hermetically so this is a permanent
// regression test, not a one-off manual check.
describe("multi-session (vscode-js-debug style)", () => {
	const MULTI_FIXTURE = path.join(
		import.meta.dir,
		"fixtures",
		"multi-session-adapter.mjs",
	);

	function multiSessionAdapter(): DapResolvedAdapter {
		return {
			name: "fake-multi-session",
			command: process.execPath,
			args: [MULTI_FIXTURE, "${port}"],
			resolvedCommand: process.execPath,
			languages: ["javascript"],
			fileTypes: [".js"],
			rootMarkers: [],
			launchDefaults: { request: "launch", type: "pwa-node" },
			attachDefaults: { request: "attach", type: "pwa-node" },
			connectMode: "tcp",
			acceptsDirectoryProgram: false,
		};
	}

	test("launch resolves stopped rather than hanging, by sending configurationDone on the CHILD connection", async () => {
		// The load-bearing assertion: without sending configurationDone on the
		// child (not just the parent), the fixture withholds the child's
		// launch/attach response forever -- exactly reproducing the real bug,
		// where `child.sendRequest(request, configuration)` never resolved and
		// the caller's own timeout was the only thing that ever cut it off.
		const mgr = new DapSessionManager();
		live.push(mgr);
		const summary = await mgr.launch(
			{
				adapter: multiSessionAdapter(),
				program: "/fake/app.js",
				cwd: process.cwd(),
			},
			undefined,
			5_000,
		);
		expect(summary.status).toBe("stopped");
		expect(summary.stopReason).toBe("breakpoint");
	});

	test("promotes the child to the session's operative client: threads reflects the child, not the parent", async () => {
		// The fixture answers `threads: []` on the parent connection and a real
		// thread on the child -- so a non-empty result here proves `s.client`
		// was actually reassigned to the child, not left pointing at the
		// bootstrapper.
		const mgr = new DapSessionManager();
		live.push(mgr);
		await mgr.launch(
			{
				adapter: multiSessionAdapter(),
				program: "/fake/app.js",
				cwd: process.cwd(),
			},
			undefined,
			5_000,
		);
		const threads = await mgr.threads(undefined, 3_000);
		expect(threads.threads).toHaveLength(1);
		expect(threads.threads[0]?.id).toBe(1);
	});

	test("terminate disposes both the parent and child connections without hanging", async () => {
		const mgr = new DapSessionManager();
		live.push(mgr);
		await mgr.launch(
			{
				adapter: multiSessionAdapter(),
				program: "/fake/app.js",
				cwd: process.cwd(),
			},
			undefined,
			5_000,
		);
		expect(await mgr.terminate(undefined, 3_000)).not.toBeNull();
		expect(mgr.listSessions()).toHaveLength(0);
	});
});
