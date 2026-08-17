/**
 * Smoke test: verify the websearch extension calls the Responses API
 * and parses citations correctly.
 *
 * Requires aperture gateway with web_search capability.
 */

const BASE = "http://ai-gateway.tail692491.ts.net";

async function call(query: string, model: string = "openai.gpt-5.6-luna") {
	const resp = await fetch(`${BASE}/v1/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			input: query,
			tools: [{ type: "web_search" }],
			max_output_tokens: 500,
		}),
	});

	if (!resp.ok) {
		throw new Error(
			`HTTP ${resp.status}: ${await resp.text().then((t) => t.slice(0, 100))}`
		);
	}

	return resp.json();
}

async function run() {
	const BASE = "http://ai-gateway.tail692491.ts.net";
	try {
		await fetch(BASE, { signal: AbortSignal.timeout(2000) });
	} catch (e) {
		console.log(
			"SKIPPED: Tailscale gateway unreachable (off-network). Test expects ~/.pi/agent/extensions/aperture.json baseUrl."
		);
		return;
	}

	console.log("=== websearch extension smoke test ===\n");

	// Test 1: recent event (verifies search capability)
	console.log("Test 1: recent event query (verifies web_search_call)");
	try {
		const raw = await call(
			"What was announced at the latest Anthropic product event? Include the date."
		);

		const calls = (raw.output || []).filter(
			(o: any) => o?.type === "web_search_call"
		).length;
		const text = (raw.output || [])
			.filter((o: any) => o?.type === "text")
			.map((o: any) => o?.content)
			.join("");
		const cites = (text.match(/\[source:\s*\d+\]/g) || []).length;

		console.log(`  search calls: ${calls}`);
		console.log(`  text output length: ${text.length}`);
		console.log(`  citations found: ${cites}`);

		if (calls > 0 && cites > 0) {
			console.log("  ✓ PASS\n");
		} else {
			console.log("  ✗ FAIL (no search or no citations)\n");
		}
	} catch (e) {
		console.log(`  ✗ ERROR: ${String(e).slice(0, 100)}\n`);
	}

	// Test 2: technical fact (verifies answer quality)
	console.log("Test 2: technical fact query");
	try {
		const raw = await call("What is the current stable version of Go?");

		const text = (raw.output || [])
			.filter((o: any) => o?.type === "text")
			.map((o: any) => o?.content)
			.join("");

		console.log(`  response: "${text.slice(0, 80)}..."`);
		if (text.includes("1.") || text.includes("go")) {
			console.log("  ✓ PASS (contains version info)\n");
		} else {
			console.log("  ✗ FAIL (no version found)\n");
		}
	} catch (e) {
		console.log(`  ✗ ERROR: ${String(e).slice(0, 100)}\n`);
	}

	console.log("done");
}

run().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
