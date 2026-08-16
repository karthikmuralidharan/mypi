/**
 * Transport smoke test — verifies each configured adapter completes a DAP
 * `initialize` handshake through the vendored DapClient.
 *
 * Covers all three transports:
 *   stdio  — debugpy
 *   socket — dlv (adapter announces its port on stdout)
 *   tcp    — js-debug (we assign the port via ${port})
 *
 * Run:  bun extensions/dap/smoke.ts
 * This is the check that upstream @piex-dev/dap fails: it parses
 * connectMode "socket" and then ignores it, so dlv and js-debug never connect.
 */

import { DapClient } from "./client";
import { resolveAdapter } from "./config";

const CWD = process.cwd();
const TARGETS = ["debugpy", "dlv", "js-debug-adapter"] as const;

type Result = { name: string; ok: boolean; mode: string; detail: string };

async function check(name: string): Promise<Result> {
	const adapter = resolveAdapter(name, CWD);
	if (!adapter) {
		return {
			name,
			ok: false,
			mode: "?",
			detail: "adapter command not found on this machine",
		};
	}
	const mode = adapter.connectMode;
	let client: DapClient | undefined;
	try {
		client = await DapClient.spawn({ adapter, cwd: CWD });
		const caps = await client.initialize(
			{
				clientID: "mypi-smoke",
				adapterID: name,
				pathFormat: "path",
				linesStartAt1: true,
				columnsStartAt1: true,
			},
			undefined,
			15_000,
		);
		const enabled = Object.keys(caps).filter(
			(k) => (caps as Record<string, unknown>)[k] === true,
		);
		return { name, ok: true, mode, detail: `${enabled.length} capabilities` };
	} catch (err) {
		return {
			name,
			ok: false,
			mode,
			detail: err instanceof Error ? err.message : String(err),
		};
	} finally {
		await client?.dispose();
	}
}

const results: Result[] = [];
for (const t of TARGETS) results.push(await check(t));

for (const r of results) {
	const tag = r.ok ? "OK  " : "FAIL";
	console.log(`${tag} ${r.name.padEnd(18)} ${r.mode.padEnd(7)} ${r.detail}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(
	`\n${results.length - failed}/${results.length} adapters completed the DAP handshake`,
);
process.exit(failed === 0 ? 0 : 1);
