/**
 * Response shaping for web_research.
 *
 * WHY THIS EXISTS: the OpenAI Responses API returns a lot per search. A single
 * observed query ("current stable Go version") produced 8 `web_search_call`
 * items and 20 `reasoning` items alongside one message. Returning that verbatim
 * would cost more context than the answer is worth, so this module reduces a
 * response to the two things that matter: the synthesized answer, and the
 * sources it cited.
 *
 * Kept as pure functions so the shaping is unit-testable without network calls.
 */

export const RESEARCH_CAPS = {
	/** Max characters of answer text returned. */
	answerChars: 6_000,
	/** Max distinct citations listed. */
	citations: 12,
	/** Max characters for a single citation title. */
	titleChars: 120,
} as const;

export interface Citation {
	url: string;
	title?: string;
}

export interface ShapedResearch {
	answer: string;
	citations: Citation[];
	searchCalls: number;
	truncated: boolean;
	status?: string;
	incomplete?: string;
}

interface RawAnnotation {
	type?: string;
	url?: string;
	title?: string;
}
interface RawContent {
	text?: string;
	annotations?: RawAnnotation[];
}
interface RawOutputItem {
	type?: string;
	content?: RawContent[];
}
export interface RawResponse {
	output?: RawOutputItem[];
	status?: string;
	incomplete_details?: unknown;
	error?: unknown;
}

function clip(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

/**
 * Collect deduped url_citation annotations, in first-seen order.
 *
 * Exported so the nested walk is directly testable, and so shapeResearch stays
 * simple enough to read at a glance.
 */
export function collectCitations(output: readonly RawOutputItem[]): Citation[] {
	const seen = new Map<string, Citation>();
	for (const item of output) {
		for (const c of item.content ?? []) {
			for (const a of c.annotations ?? []) {
				if (a?.type !== "url_citation" || !a.url || seen.has(a.url)) continue;
				// First title wins; the same source is often cited repeatedly.
				seen.set(a.url, {
					url: a.url,
					...(a.title ? { title: clip(a.title, RESEARCH_CAPS.titleChars) } : {}),
				});
			}
		}
	}
	return [...seen.values()];
}

/** Join the assistant message text, ignoring reasoning and tool-call items. */
export function extractAnswer(output: readonly RawOutputItem[]): string {
	return output
		.filter((o) => o?.type === "message")
		.flatMap((o) => o.content ?? [])
		.map((c) => c?.text ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

/**
 * Reduce a Responses payload to answer + citations.
 *
 * Reasoning and web_search_call items are counted but never included — the count
 * is useful signal (it reveals how much work the query cost) while the bodies
 * are pure context bloat.
 */
export function shapeResearch(raw: RawResponse): ShapedResearch {
	const output = Array.isArray(raw.output) ? raw.output : [];
	const searchCalls = output.filter((o) => o?.type === "web_search_call").length;
	const answerRaw = extractAnswer(output);
	const all = collectCitations(output);
	const citations = all.slice(0, RESEARCH_CAPS.citations);
	const answer = clip(answerRaw, RESEARCH_CAPS.answerChars);

	return {
		answer,
		citations,
		searchCalls,
		truncated:
			answerRaw.length > RESEARCH_CAPS.answerChars ||
			all.length > citations.length,
		...(raw.status ? { status: raw.status } : {}),
		...(raw.incomplete_details
			? { incomplete: JSON.stringify(raw.incomplete_details) }
			: {}),
	};
}

/** Render for the model: answer, then a Sources list it can cite from. */
export function renderResearch(r: ShapedResearch): string {
	const lines: string[] = [];
	lines.push(r.answer || "(no answer returned)");
	if (r.citations.length) {
		lines.push("", "Sources:");
		for (const c of r.citations) {
			lines.push(c.title ? `- [${c.title}](${c.url})` : `- ${c.url}`);
		}
	} else {
		// Absence of citations is meaningful: the search ran but retrieved nothing
		// usable (some sites block the fetcher), so the answer may be unsourced.
		lines.push("", "Sources: none returned — treat this answer as unverified.");
	}
	const notes: string[] = [`${r.searchCalls} search call(s)`];
	if (r.truncated) notes.push("output truncated");
	if (r.incomplete) notes.push(`incomplete: ${r.incomplete}`);
	lines.push("", `_(${notes.join("; ")})_`);
	return lines.join("\n");
}
