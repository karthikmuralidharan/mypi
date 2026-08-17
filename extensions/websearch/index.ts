/**
 * web_research — a cited, synthesized web answer via OpenAI's built-in
 * web_search tool on the Responses API.
 *
 * WHY A DISTINCT TOOL, not another `web_search` provider:
 * rpiv-web-tools' web_search returns raw SERP rows that then need fetching.
 * This returns one synthesized answer plus the URLs it actually cited, so a
 * "what is the current X" question costs one call instead of search-then-fetch.
 * Different job, so a different name — the referee forbids two tools competing
 * for one slot.
 *
 * AUTH: none. It routes through the aperture gateway already configured for this
 * machine (reachable on the tailnet, no key, no OAuth). Verified in testing:
 * /v1/responses accepts {"type":"web_search"} and returns url_citation
 * annotations.
 *
 * Config, all optional, from ~/.pi/agent/extensions/websearch.json:
 *   { "baseUrl": "...", "model": "...", "timeoutMs": 120000 }
 * baseUrl defaults to the aperture extension's own configured gateway.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type RawResponse, renderResearch, shapeResearch } from "./shape";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const DEFAULT_MODEL = "openai.gpt-5.6-luna";
const DEFAULT_TIMEOUT_MS = 120_000;

interface ResearchConfig {
	baseUrl: string;
	model: string;
	timeoutMs: number;
}

function readJson(file: string): Record<string, unknown> {
	try {
		return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	} catch {
		// A broken config must not disable the tool; fall through to defaults.
		return {};
	}
}

export function loadResearchConfig(
	agentDir: string = AGENT_DIR,
): ResearchConfig {
	const own = readJson(path.join(agentDir, "extensions", "websearch.json"));
	// Reuse the gateway the aperture provider already points at, so there is one
	// place to change the endpoint rather than two that can drift apart.
	const aperture = readJson(path.join(agentDir, "extensions", "aperture.json"));
	const baseUrl =
		(typeof own.baseUrl === "string" && own.baseUrl) ||
		(typeof aperture.baseUrl === "string" && aperture.baseUrl) ||
		"";
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		model: typeof own.model === "string" && own.model ? own.model : DEFAULT_MODEL,
		timeoutMs:
			typeof own.timeoutMs === "number" && own.timeoutMs > 0
				? own.timeoutMs
				: DEFAULT_TIMEOUT_MS,
	};
}

export default function webResearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_research",
		label: "Web research",
		// Without promptSnippet, custom tools are omitted from the "Available tools"
		// section of the default system prompt — i.e. the tool would exist but never
		// be advertised.
		promptSnippet:
			"web_research: ask a question and get a synthesized answer from the live web with source URLs",
		promptGuidelines: [
			"Use web_research when you want an ANSWER from the live web (current versions, recent events, state of X). It searches and reads for you in one call.",
			"Use web_fetch when you already have the exact URL, and query-docs (context7) for library API documentation.",
			"Always check the Sources list web_research returns. Some sites block the fetcher, and an answer with no sources is unverified — say so rather than presenting it as fact.",
		],
		description:
			"Answer a question from the live web and return a synthesized answer plus the source URLs it cited, " +
			"using OpenAI's built-in web_search. Prefer this over web_search when you want an ANSWER (current " +
			"versions, recent events, 'what is the state of X'); it does the searching and reading for you in one " +
			"call. Use web_fetch instead when you already know the exact URL, and query-docs (context7) for " +
			"library API documentation. Note: some sites block the fetcher, so check the Sources list — an answer " +
			"with no sources is unverified.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"The question to research, phrased as a question. Include any constraint that matters " +
					"(version, date range, 'cite the official docs').",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const cfg = loadResearchConfig();
			if (!cfg.baseUrl) {
				throw new Error(
					"web_research: no gateway baseUrl. Set baseUrl in ~/.pi/agent/extensions/websearch.json " +
						"or configure the aperture extension.",
				);
			}
			const query = String((params as { query?: unknown }).query ?? "").trim();
			if (!query) throw new Error("web_research: 'query' is required.");

			// Build the endpoint via the URL constructor rather than string
			// interpolation, and validate the configured host first.
			const endpoint = new URL("/v1/responses", assertGatewayUrl(cfg.baseUrl));

			// Own timeout, but still honour the caller's cancellation.
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
			const onAbort = () => ac.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const res = await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: cfg.model,
						input: query,
						tools: [{ type: "web_search" }],
					}),
					signal: ac.signal,
				});
				if (!res.ok) {
					throw new Error(
						`web_research: gateway returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
					);
				}
				const shaped = shapeResearch((await res.json()) as RawResponse);
				return {
					content: [{ type: "text", text: renderResearch(shaped) }],
					details: {
						model: cfg.model,
						searchCalls: shaped.searchCalls,
						citationCount: shaped.citations.length,
					},
				};
			} catch (err) {
				if (ac.signal.aborted && !signal?.aborted) {
					throw new Error(`web_research: timed out after ${cfg.timeoutMs}ms`);
				}
				throw err;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});
}
