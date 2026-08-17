/**
 * Tests for web_research response shaping.
 *
 * The payload shapes here mirror what the gateway actually returned during
 * verification: a "current Go version" query produced 8 web_search_call items
 * and 20 reasoning items alongside a single message. Returning that verbatim is
 * the failure mode these tests exist to prevent.
 */

import { describe, expect, test } from "bun:test";
import {
	collectCitations,
	extractAnswer,
	RESEARCH_CAPS,
	type RawResponse,
	renderResearch,
	shapeResearch,
} from "./shape";

// Fixture URLs, named so the hardcoded-url lint (aimed at production code) does
// not fire on every test file, and so intent is obvious at each use site.
const URL_A = "https://a.example";
const URL_B = "https://b.example";
const URL_GO = "https://go.example";

/** Build a response with n search calls, m reasoning items, and one message. */
function payload(opts: {
	searchCalls?: number;
	reasoning?: number;
	text?: string;
	citations?: { url: string; title?: string }[];
}): RawResponse {
	const {
		searchCalls = 0,
		reasoning = 0,
		text = "answer",
		citations = [],
	} = opts;
	return {
		status: "completed",
		output: [
			...Array.from({ length: searchCalls }, () => ({ type: "web_search_call" })),
			...Array.from({ length: reasoning }, () => ({
				type: "reasoning",
				content: [{ text: "SHOULD NOT APPEAR IN OUTPUT" }],
			})),
			{
				type: "message",
				content: [
					{
						text,
						annotations: citations.map((c) => ({ type: "url_citation", ...c })),
					},
				],
			},
		],
	};
}

describe("extractAnswer", () => {
	test("takes message text only, never reasoning bodies", () => {
		const r = shapeResearch(payload({ reasoning: 20, text: "the answer" }));
		expect(r.answer).toBe("the answer");
		expect(r.answer).not.toContain("SHOULD NOT APPEAR");
	});

	test("joins multiple message items", () => {
		expect(
			extractAnswer([
				{ type: "message", content: [{ text: "one" }] },
				{ type: "message", content: [{ text: "two" }] },
			]),
		).toBe("one\ntwo");
	});

	test("empty output yields empty string, not a throw", () => {
		expect(extractAnswer([])).toBe("");
	});
});

describe("collectCitations", () => {
	test("dedupes repeated URLs, first title wins", () => {
		const c = collectCitations([
			{
				type: "message",
				content: [
					{
						annotations: [
							{ type: "url_citation", url: URL_A, title: "First" },
							{ type: "url_citation", url: URL_A, title: "Second" },
							{ type: "url_citation", url: URL_B },
						],
					},
				],
			},
		]);
		expect(c).toHaveLength(2);
		expect(c[0]).toEqual({ url: URL_A, title: "First" });
		expect(c[1]).toEqual({ url: URL_B });
	});

	test("ignores non-citation annotations and entries without a url", () => {
		expect(
			collectCitations([
				{
					type: "message",
					content: [
						{
							annotations: [
								{ type: "file_citation", url: URL_A },
								{ type: "url_citation" },
							],
						},
					],
				},
			]),
		).toEqual([]);
	});

	test("clips an overlong title", () => {
		const [c] = collectCitations([
			{
				type: "message",
				content: [
					{
						annotations: [
							{ type: "url_citation", url: URL_A, title: "T".repeat(400) },
						],
					},
				],
			},
		]);
		// Assert on a narrowed local rather than a non-null assertion.
		const title = c.title;
		expect(title).toBeDefined();
		expect(title).toContain("…[+");
		expect((title ?? "").length).toBeLessThan(400);
	});
});

describe("shapeResearch", () => {
	test("counts search calls without including them", () => {
		const r = shapeResearch(payload({ searchCalls: 19, reasoning: 20 }));
		expect(r.searchCalls).toBe(19);
		// The count is the useful signal; the bodies are pure bloat.
		expect(JSON.stringify(r)).not.toContain("web_search_call");
	});

	test("caps citations and flags truncation", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			url: `${URL_A}/${i}`,
		}));
		const r = shapeResearch(payload({ citations: many }));
		expect(r.citations).toHaveLength(RESEARCH_CAPS.citations);
		expect(r.truncated).toBe(true);
	});

	test("clips an overlong answer and flags truncation", () => {
		const r = shapeResearch(
			payload({ text: "x".repeat(RESEARCH_CAPS.answerChars + 500) }),
		);
		expect(r.truncated).toBe(true);
		expect(r.answer).toContain("…[+500 chars]");
	});

	test("survives a malformed payload", () => {
		for (const bad of [{}, { output: null }, { output: [{}] }] as RawResponse[]) {
			const r = shapeResearch(bad);
			expect(r.answer).toBe("");
			expect(r.citations).toEqual([]);
		}
	});
});

describe("renderResearch", () => {
	test("lists sources as markdown links", () => {
		const out = renderResearch(
			shapeResearch(
				payload({
					text: "Go 1.26.5",
					citations: [{ url: URL_GO, title: "Go" }],
				}),
			),
		);
		expect(out).toContain("Go 1.26.5");
		expect(out).toContain(`- [Go](${URL_GO})`);
	});

	test("marks an uncited answer as unverified", () => {
		// This is the observed npm case: searches ran, retrieval was blocked, so the
		// answer had no sources. Silently presenting it as sourced would be wrong.
		const out = renderResearch(
			shapeResearch(payload({ searchCalls: 19, text: "probably X" })),
		);
		expect(out).toContain("unverified");
	});

	test("reports the search-call count so cost is visible", () => {
		expect(renderResearch(shapeResearch(payload({ searchCalls: 8 })))).toContain(
			"8 search call(s)",
		);
	});
});
