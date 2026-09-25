/**
 * Smoke test: verifies web_research end to end against the live gateway.
 *
 * Complements shape.test.ts, which covers the parsing with fixtures and needs no
 * network. This one proves the real thing: that the gateway accepts the built-in
 * web_search tool and that a query comes back with actual citations.
 *
 * Run: bun extensions/websearch/smoke.ts
 *
 * The extension resolves its model through pi's registry (ctx.modelRegistry);
 * this script runs outside pi, so it performs the same resolution by hand
 * against ~/.pi/agent/models.json: same websearch.json model reference, same
 * provider lookup, then the exact request the tool would send.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadResearchConfig, parseModelRef } from "./index";
import { shapeResearch } from "./shape";

interface SmokeTarget {
	endpoint: string;
	headers: Record<string, string>;
	modelId: string;
}

/** Stand-in for ctx.modelRegistry: read the same models.json pi loads. */
function resolveFromModelsJson(ref: string): SmokeTarget | undefined {
	const parsed = parseModelRef(ref);
	if (!parsed) return undefined;
	const file = path.join(os.homedir(), ".pi", "agent", "models.json");
	const providers = JSON.parse(fs.readFileSync(file, "utf8")).providers;
	const provider = providers?.[parsed.provider];
	if (typeof provider?.baseUrl !== "string") return undefined;
	const known = provider.models?.some(
		(m: { id?: unknown }) => m.id === parsed.id,
	);
	if (!known) return undefined;
	const apiKey =
		typeof provider.apiKey === "string" && !provider.apiKey.startsWith("$")
			? provider.apiKey
			: undefined;
	return {
		endpoint: `${provider.baseUrl.replace(/\/+$/, "")}/responses`,
		headers: {
			"content-type": "application/json",
			...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		},
		modelId: parsed.id,
	};
}

async function research(target: SmokeTarget, query: string, timeoutMs: number) {
	const res = await fetch(target.endpoint, {
		method: "POST",
		headers: target.headers,
		body: JSON.stringify({
			model: target.modelId,
			input: query,
			tools: [{ type: "web_search" }],
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok)
		throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return shapeResearch(await res.json());
}

/** A query needs a real search AND at least one citation to count as passing. */
async function check(
	target: SmokeTarget,
	timeoutMs: number,
	label: string,
	query: string,
): Promise<boolean> {
	try {
		const r = await research(target, query, timeoutMs);
		const ok = r.searchCalls > 0 && r.citations.length > 0;
		console.log(
			`${ok ? "OK  " : "FAIL"} ${label.padEnd(22)} searchCalls=${r.searchCalls} citations=${r.citations.length}`,
		);
		if (r.citations[0]) console.log(`       first source: ${r.citations[0].url}`);
		if (!ok) console.log(`       answer: ${r.answer.slice(0, 160)}`);
		return ok;
	} catch (err) {
		console.log(
			`FAIL ${label.padEnd(22)} ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

async function main(): Promise<void> {
	const cfg = loadResearchConfig();
	const target = resolveFromModelsJson(cfg.model);
	if (!target) {
		console.log(
			`SKIPPED: "${cfg.model}" is not a provider/model reference in ~/.pi/agent/models.json.`,
		);
		return;
	}

	// Off-network is a skip, not a failure — the gateway lives on a tailnet.
	const origin = new URL(target.endpoint).origin;
	try {
		await fetch(origin, { signal: AbortSignal.timeout(3000) });
	} catch {
		console.log(`SKIPPED: gateway ${origin} unreachable (off-network).`);
		return;
	}

	console.log(`=== web_research smoke test (${cfg.model} via ${origin}) ===`);
	const results = [
		await check(
			target,
			cfg.timeoutMs,
			"technical fact",
			"What is the current stable version of Go? Cite the official source.",
		),
		await check(
			target,
			cfg.timeoutMs,
			"recent news",
			"Give one recent headline about the Anthropic Claude API, with the source URL.",
		),
	];

	const passed = results.filter(Boolean).length;
	console.log(`\n${passed}/${results.length} queries returned a cited answer`);
	if (passed !== results.length) process.exitCode = 1;
}

await main();
