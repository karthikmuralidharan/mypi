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
 * ROUTING: the tool runs against a model from pi's own model registry
 * (models.json), resolved through ctx.modelRegistry — endpoint and
 * credentials come from the provider that owns the model, so there is no
 * separate baseUrl to keep in sync. Verified in testing: the aperture
 * gateway's Responses API accepts {"type":"web_search"} and returns
 * url_citation annotations.
 *
 * Config, all optional, from ~/.pi/agent/extensions/websearch.json:
 *   { "model": "provider/model-id", "timeoutMs": 120000 }
 * "model" is a registry reference (see pi --list-models) and must name a
 * model whose provider speaks the Responses API.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type RawResponse, renderResearch, shapeResearch } from "./shape";
import { assertHttpUrl, bodyToText, capFetchText, FETCH_CAPS } from "./fetch";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const DEFAULT_MODEL_REF = "aperture-responses/gpt-5.6-luna";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ResearchConfig {
	/** "provider/model-id" reference into pi's model registry. */
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
	return {
		model:
			typeof own.model === "string" && own.model.trim()
				? own.model.trim()
				: DEFAULT_MODEL_REF,
		timeoutMs:
			typeof own.timeoutMs === "number" && own.timeoutMs > 0
				? own.timeoutMs
				: DEFAULT_TIMEOUT_MS,
	};
}

/** Split a "provider/model-id" reference; undefined when malformed. */
export function parseModelRef(
	ref: string,
): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** Mirrors the (non-exported) result of ModelRegistry.getApiKeyAndHeaders. */
export type ResearchAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }
	| { ok: false; error: string };

/** The slice of pi's model registry the tool needs — structural, so tests can fake it. */
export interface ResearchRegistry {
	find(provider: string, id: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<ResearchAuth>;
}

export interface ResearchTarget {
	endpoint: URL;
	headers: Record<string, string>;
	modelId: string;
}

/**
 * Resolve the configured model reference through pi's registry: the endpoint
 * and credentials come from the provider that owns the model, so the tool
 * tracks models.json instead of keeping its own baseUrl copy.
 */
export async function resolveResearchTarget(
	registry: ResearchRegistry,
	ref: string,
): Promise<ResearchTarget> {
	const parsed = parseModelRef(ref);
	const model = parsed && registry.find(parsed.provider, parsed.id);
	if (!model) {
		throw new Error(
			`web_research: "${ref}" is not a provider/model reference in pi's registry ` +
				`(see pi --list-models). Set "model" in ~/.pi/agent/extensions/websearch.json.`,
		);
	}
	if (model.api !== "openai-responses") {
		throw new Error(
			`web_research: ${ref} uses the "${model.api}" API; the built-in web_search ` +
				`tool requires a model whose provider speaks "openai-responses".`,
		);
	}
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(
			`web_research: cannot resolve credentials for ${ref}: ${auth.error}`,
		);
	}
	const base = assertHttpUrl(auth.baseUrl ?? model.baseUrl, `baseUrl of ${ref}`)
		.href.replace(/\/+$/, "");
	const headers: Record<string, string> = { "content-type": "application/json" };
	// A null header value unsets a default; fetch only takes strings.
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value == null) delete headers[name];
		else headers[name] = value;
	}
	if (
		auth.apiKey &&
		!Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
	) {
		headers.authorization = `Bearer ${auth.apiKey}`;
	}
	return { endpoint: new URL(`${base}/responses`), headers, modelId: model.id };
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cfg = loadResearchConfig();
			const target = await resolveResearchTarget(ctx.modelRegistry, cfg.model);
			const query = String(params.query ?? "").trim();
			if (!query) throw new Error("web_research: 'query' is required.");

			// Own timeout, but still honour the caller's cancellation.
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
			const onAbort = () => ac.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const res = await fetch(target.endpoint, {
					method: "POST",
					headers: target.headers,
					body: JSON.stringify({
						model: target.modelId,
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

	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		promptSnippet:
			"web_fetch: fetch one known URL and return readable text with navigation chrome stripped and length capped",
		promptGuidelines: [
			"Use web_fetch for a URL you already hold and want to read now. Use web_research when you have a QUESTION rather than a URL, and ctx_fetch_and_index for large pages or several pages you want to search rather than read.",
			"web_fetch strips nav/header/footer/aside and caps length. If it reports truncation, either raise max_chars deliberately or switch to ctx_fetch_and_index — do not assume you saw the whole page.",
		],
		description:
			"Fetch a single URL and return readable text: scripts, styles and navigation chrome are removed, " +
			"HTML entities decoded, JSON pretty-printed, and output length capped with an explicit truncation " +
			"note. Use for a URL you already have. For a question rather than a URL use web_research; for large " +
			"or multiple pages you want to search rather than read, use ctx_fetch_and_index.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL to fetch." }),
			max_chars: Type.Optional(
				Type.Number({
					description: `Characters of extracted text to return (default ${FETCH_CAPS.textChars}).`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as { url?: unknown; max_chars?: unknown };
			// Validate before fetching: the URL comes from model output, so it is
			// untrusted input to an outbound request.
			const url = assertHttpUrl(String(p.url ?? "").trim(), "url");
			const maxChars =
				typeof p.max_chars === "number" && p.max_chars > 0
					? p.max_chars
					: FETCH_CAPS.textChars;

			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 30_000);
			const onAbort = () => ac.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const res = await fetch(url, {
					redirect: "follow",
					headers: {
						accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
					},
					signal: ac.signal,
				});
				if (!res.ok) {
					throw new Error(
						`web_fetch: HTTP ${res.status} ${res.statusText} for ${url.href}`,
					);
				}
				const body = await res.text();
				if (body.length > FETCH_CAPS.responseBytes) {
					throw new Error(
						`web_fetch: response exceeds ${FETCH_CAPS.responseBytes} bytes; use ctx_fetch_and_index instead`,
					);
				}
				const contentType = res.headers.get("content-type") ?? "";
				const shaped = capFetchText(bodyToText(body, contentType), maxChars);
				return {
					content: [
						{
							type: "text",
							text: `# ${url.href}\n(${contentType || "unknown type"})\n\n${shaped.text}`,
						},
					],
					details: {
						url: url.href,
						contentType,
						rawChars: body.length,
						returnedChars: shaped.text.length,
						truncated: shaped.truncated,
					},
				};
			} catch (err) {
				if (ac.signal.aborted && !signal?.aborted) {
					throw new Error(`web_fetch: timed out after 30000ms for ${url.href}`);
				}
				throw err;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});
}
