/**
 * Unit tests for the locally-added transport layer and the upstream fixes.
 *
 * Scope note: upstream @piex-dev/dap ships zero tests, and the oh-my-pi original
 * it was ported from has ~1,738 lines of DAP tests that the port dropped. These
 * cover the code THIS repo changed — transport selection, address parsing,
 * connectMode normalisation, and message framing — not the whole DAP surface.
 *
 * These are hermetic: no debug adapters required, no processes spawned except
 * one trivial port-reservation check. `smoke.ts` is the complementary
 * integration check that needs real adapters.
 *
 * Run: bun test extensions/dap
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DapClient, parseAnnouncedAddress, substitutePort } from "./client";
import {
	getAdapterConfigs,
	clearAdapterConfigCache,
	resolveAdapter,
} from "./config";
import type { DapResolvedAdapter } from "./types";

// ---------------------------------------------------------------------------
// parseAnnouncedAddress — `socket` mode scrapes this from adapter stdout
// ---------------------------------------------------------------------------

describe("parseAnnouncedAddress", () => {
	test("parses the IPv4 form dlv actually emits", () => {
		expect(
			parseAnnouncedAddress("DAP server listening at: 127.0.0.1:51272"),
		).toEqual({
			host: "127.0.0.1",
			port: 51272,
		});
	});

	test("parses bare IPv6, which a host-then-port regex silently misses", () => {
		// This is the shape js-debug prints; the original regex returned null here.
		expect(parseAnnouncedAddress("Debug server listening at ::1:12345")).toEqual({
			host: "::1",
			port: 12345,
		});
	});

	test("parses bracketed IPv6 and strips the brackets", () => {
		expect(parseAnnouncedAddress("listening on [::1]:8123")).toEqual({
			host: "::1",
			port: 8123,
		});
	});

	test("is case- and punctuation-insensitive around the marker", () => {
		expect(parseAnnouncedAddress("LISTENING ON 127.0.0.1:4711")?.port).toBe(4711);
		expect(parseAnnouncedAddress("listening at: 127.0.0.1:4711")?.port).toBe(
			4711,
		);
	});

	test("returns null for a partial line so the caller keeps accumulating", () => {
		// Critical: committing to a parse mid-chunk would dial the wrong port.
		expect(
			parseAnnouncedAddress("DAP server listening at: 127.0.0.1"),
		).toBeNull();
		expect(parseAnnouncedAddress("DAP server listen")).toBeNull();
	});

	test("returns null for a unix socket path (no port to dial)", () => {
		expect(parseAnnouncedAddress("listening at /tmp/dap.sock")).toBeNull();
	});

	test("rejects out-of-range and non-numeric ports", () => {
		expect(parseAnnouncedAddress("listening at 127.0.0.1:99999")).toBeNull();
		expect(parseAnnouncedAddress("listening at 127.0.0.1:0")).toBeNull();
		expect(parseAnnouncedAddress("listening at 127.0.0.1:abc")).toBeNull();
	});

	test("ignores unrelated adapter chatter", () => {
		expect(
			parseAnnouncedAddress("Type 'help' for a list of commands."),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// substitutePort — `tcp` mode injects a port we chose
// ---------------------------------------------------------------------------

describe("substitutePort", () => {
	test("replaces the placeholder and leaves other args untouched", () => {
		expect(
			substitutePort(["/path/dapDebugServer.js", "${port}", "127.0.0.1"], 5555),
		).toEqual(["/path/dapDebugServer.js", "5555", "127.0.0.1"]);
	});

	test("replaces every occurrence", () => {
		expect(substitutePort(["--port=${port}", "--advertise=${port}"], 42)).toEqual(
			["--port=42", "--advertise=42"],
		);
	});

	test("is a no-op when no placeholder is present", () => {
		expect(substitutePort(["dap"], 42)).toEqual(["dap"]);
	});
});

// ---------------------------------------------------------------------------
// connectMode normalisation — the upstream bug that silently degraded to stdio
// ---------------------------------------------------------------------------

describe("adapter connectMode normalisation", () => {
	// Isolate from real config. getAdapterConfigs() now searches
	// ~/.pi/agent/dap.json and <cwd>/.dap.json, so without an empty cwd and a
	// redirected user path these assertions would silently depend on whatever this
	// machine happens to have configured.
	const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dap-cfg-"));
	const configs = () => {
		process.env.PI_DAP_CONFIG = path.join(emptyDir, "absent.json");
		clearAdapterConfigCache();
		try {
			return getAdapterConfigs(emptyDir);
		} finally {
			delete process.env.PI_DAP_CONFIG;
			clearAdapterConfigCache();
		}
	};

	test("dlv keeps socket mode instead of degrading to stdio", () => {
		// Upstream whitelisted only "socket" here but then never implemented it;
		// any other value fell through to "stdio" and surfaced as an init timeout.
		expect(configs()["dlv"]?.connectMode).toBe("socket");
	});

	test("js-debug is configured for tcp, not stdio", () => {
		expect(configs()["js-debug-adapter"]?.connectMode).toBe("tcp");
	});

	test("stdio adapters report stdio once resolved", () => {
		const resolved = resolveAdapter("debugpy", process.cwd());
		// Only assert when the adapter is actually installed on this machine.
		if (resolved) expect(resolved.connectMode).toBe("stdio");
	});

	test("every declared mode is one the client implements", () => {
		const implemented = new Set(["stdio", "socket", "tcp"]);
		for (const [name, cfg] of Object.entries(configs())) {
			const mode = cfg.connectMode ?? "stdio";
			expect(
				implemented.has(mode),
				`${name} declares unimplemented mode ${mode}`,
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Framing over an injected transport — no adapter process needed
// ---------------------------------------------------------------------------

/** Minimal ChildProcess stand-in: DapClient only needs exit/kill/stderr. */
function fakeProc(): ChildProcess {
	const ee = new EventEmitter() as unknown as ChildProcess & {
		exitCode: number | null;
	};
	ee.exitCode = null;
	(ee as unknown as { kill: () => boolean }).kill = () => true;
	(ee as unknown as { stderr: null }).stderr = null;
	return ee;
}

function fakeAdapter(): DapResolvedAdapter {
	return {
		name: "fake",
		command: "fake",
		args: [],
		resolvedCommand: "/bin/fake",
		languages: [],
		fileTypes: [],
		rootMarkers: [],
		launchDefaults: {},
		attachDefaults: {},
		connectMode: "stdio",
		acceptsDirectoryProgram: false,
	};
}

function frame(obj: unknown): string {
	const body = JSON.stringify(obj);
	return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

/** Wires a DapClient to in-memory streams and echoes framed replies. */
function harness() {
	const toClient = new PassThrough(); // adapter -> client
	const fromClient = new PassThrough(); // client -> adapter
	const client = new DapClient(fakeAdapter(), process.cwd(), fakeProc(), {
		readable: toClient,
		writable: fromClient,
		close: () => {},
	});
	return { client, toClient, fromClient };
}

describe("DapClient framing over an injected transport", () => {
	test("matches a response to its request by seq", async () => {
		const { client, toClient, fromClient } = harness();
		fromClient.once("data", (buf: Buffer) => {
			const seq = JSON.parse(buf.toString().split("\r\n\r\n")[1]).seq;
			toClient.write(
				frame({
					seq: 1,
					type: "response",
					request_seq: seq,
					success: true,
					command: "initialize",
					body: { supportsFoo: true },
				}),
			);
		});
		await expect(
			client.sendRequest("initialize", {}, undefined, 3000),
		).resolves.toEqual({
			supportsFoo: true,
		});
		await client.dispose();
	});

	test("rejects when the adapter reports failure", async () => {
		const { client, toClient, fromClient } = harness();
		fromClient.once("data", (buf: Buffer) => {
			const seq = JSON.parse(buf.toString().split("\r\n\r\n")[1]).seq;
			toClient.write(
				frame({
					seq: 1,
					type: "response",
					request_seq: seq,
					success: false,
					command: "launch",
					message: "boom",
				}),
			);
		});
		await expect(
			client.sendRequest("launch", {}, undefined, 3000),
		).rejects.toThrow("boom");
		await client.dispose();
	});

	test("reassembles a message split across chunk boundaries", async () => {
		// The real failure mode this guards: a `stopped` event arriving in two TCP reads.
		const { client, toClient } = harness();
		const seen = client.waitForEvent<{ reason: string }>(
			"stopped",
			undefined,
			undefined,
			3000,
		);
		const full = frame({
			seq: 9,
			type: "event",
			event: "stopped",
			body: { reason: "breakpoint" },
		});
		const cut = Math.floor(full.length / 2);
		toClient.write(full.slice(0, cut));
		await Bun.sleep(10);
		toClient.write(full.slice(cut));
		await expect(seen).resolves.toEqual({ reason: "breakpoint" });
		await client.dispose();
	});

	test("handles two messages delivered in a single chunk", async () => {
		const { client, toClient } = harness();
		const first = client.waitForEvent("initialized", undefined, undefined, 3000);
		const second = client.waitForEvent<{ reason: string }>(
			"stopped",
			undefined,
			undefined,
			3000,
		);
		toClient.write(
			frame({ seq: 1, type: "event", event: "initialized" }) +
				frame({
					seq: 2,
					type: "event",
					event: "stopped",
					body: { reason: "step" },
				}),
		);
		await first;
		await expect(second).resolves.toEqual({ reason: "step" });
		await client.dispose();
	});

	test("survives a malformed header without dropping the next message", async () => {
		const { client, toClient } = harness();
		const seen = client.waitForEvent("initialized", undefined, undefined, 3000);
		toClient.write("Content-Type: nonsense\r\n\r\n");
		toClient.write(frame({ seq: 1, type: "event", event: "initialized" }));
		await expect(seen).resolves.toBeUndefined();
		await client.dispose();
	});

	test("times out a request with no reply", async () => {
		const { client } = harness();
		await expect(
			client.sendRequest("threads", {}, undefined, 60),
		).rejects.toThrow(/timed out/);
		await client.dispose();
	});

	test("dispose rejects in-flight requests rather than hanging", async () => {
		const { client } = harness();
		const inflight = client.sendRequest("threads", {}, undefined, 5000);
		await client.dispose();
		await expect(inflight).rejects.toThrow(/disposed/);
	});

	test("writes well-formed Content-Length framing", async () => {
		const { client, fromClient } = harness();
		const wrote = new Promise<string>((res) =>
			fromClient.once("data", (b: Buffer) => res(b.toString())),
		);
		client.sendRequest("threads", { a: 1 }, undefined, 500).catch(() => {});
		const raw = await wrote;
		const [header, body] = raw.split("\r\n\r\n");
		expect(header).toMatch(/^Content-Length: \d+$/);
		expect(Number(/(\d+)/.exec(header)![1])).toBe(
			Buffer.byteLength(body, "utf-8"),
		);
		expect(JSON.parse(body)).toMatchObject({
			type: "request",
			command: "threads",
			arguments: { a: 1 },
		});
		await client.dispose();
	});
});
