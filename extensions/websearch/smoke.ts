/**
 * Smoke test: verifies web_research end to end against the live gateway.
 *
 * Complements shape.test.ts, which covers the parsing with fixtures and needs no
 * network. This one proves the real thing: that the gateway accepts the built-in
 * web_search tool and that a query comes back with actual citations.
 *
 * Run: bun extensions/websearch/smoke.ts
 *
 * It deliberately reuses loadResearchConfig and shapeResearch rather than
 * re-implementing them. The previous version hardcoded the gateway URL and
 * parsed a payload shape the API does not produce (`type: "text"` items and
 * `[source: N]` markers instead of `type: "message"` and url_citation
 * annotations), so both of its checks reported FAIL even when the tool worked.
 */

import { loadResearchConfig } from "./index";
import { shapeResearch } from "./shape";

const cfg = loadResearchConfig();

async function research(query: string) {
	const res = await fetch(`${cfg.baseUrl}/v1/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: cfg.model,
			input: query,
			tools: [{ type: "web_search" }],
		}),
		signal: AbortSignal.timeout(cfg.timeoutMs),
	});
	if (!res.ok)
		throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return shapeResearch(await res.json());
}

/** A query needs a real search AND at least one citation to count as passing. */
async function check(label: string, query: string): Promise<boolean> {
	try {
		const r = await research(query);
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

if (!cfg.baseUrl) {
	console.log(
		"SKIPPED: no gateway baseUrl configured (aperture.json or websearch.json).",
	);
	process.exit(0);
}

// Off-network is a skip, not a failure — the gateway lives on a tailnet.
try {
	await fetch(cfg.baseUrl, { signal: AbortSignal.timeout(3000) });
} catch {
	console.log(`SKIPPED: gateway ${cfg.baseUrl} unreachable (off-network).`);
	process.exit(0);
}

console.log(
	`=== web_research smoke test (${cfg.model} via ${cfg.baseUrl}) ===`,
);
const results = [
	await check(
		"technical fact",
		"What is the current stable version of Go? Cite the official source.",
	),
	await check(
		"recent news",
		"Give one recent headline about the Anthropic Claude API, with the source URL.",
	),
];

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} queries returned a cited answer`);
process.exit(passed === results.length ? 0 : 1);
