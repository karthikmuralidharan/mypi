/**
 * URL fetching with output shaping, for the `web_fetch` tool.
 *
 * WHY THIS EXISTS: rpiv-web-tools' web_fetch returned raw pages including
 * navigation chrome — measured at 21KB to answer one question that web_research
 * answered in 226 bytes. Fetching a known URL is still a job worth having, so
 * this keeps the capability but bounds the cost.
 *
 * Split of responsibility, so the two web tools do not overlap:
 *   web_fetch            — a URL you hold, want the text now, bounded
 *   ctx_fetch_and_index  — large or many pages, want searchable retrieval
 *   web_research         — a question, not a URL
 *
 * Pure functions, so the shaping is unit-testable without network access.
 */

export const FETCH_CAPS = {
	/** Characters of extracted text returned by default. */
	textChars: 10_000,
	/** Hard ceiling on the response body read from the wire. */
	responseBytes: 5 * 1024 * 1024,
} as const;

/**
 * Validate a URL before it is used as a fetch target.
 *
 * URLs reach this from model input or config, so both are untrusted. Restricting
 * to http/https keeps file:, data: and similar schemes out of an outbound sink.
 */
export function assertHttpUrl(raw: string, label = "url"): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${label} is not a valid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${label} must be http(s), got ${url.protocol}`);
	}
	return url;
}

/** Blocks whose contents are never useful as text. */
const DROP_BLOCKS =
	/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Structural chrome: menus, banners, footers, sidebars. */
const DROP_CHROME = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Tags that should become a line break rather than vanish. */
const BREAK_TAGS =
	/<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre)\b[^>]*>/gi;

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
	"&nbsp;": " ",
};

function decodeEntities(s: string): string {
	return s
		.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) =>
			String.fromCodePoint(Number.parseInt(h, 16)),
		);
}

/**
 * Reduce HTML to readable text.
 *
 * Chrome removal is the point: a docs page is mostly menus, and those menus are
 * what made the old tool expensive. Dropping them before stripping tags means
 * the caller pays for prose, not for a navigation tree.
 */
export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(DROP_BLOCKS, " ")
			.replace(DROP_CHROME, " ")
			.replace(BREAK_TAGS, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.split("\n")
		.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
		.filter((line, i, all) => line !== "" || all[i - 1] !== "")
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface ShapedFetch {
	text: string;
	droppedChars: number;
	truncated: boolean;
}

/**
 * Cap extracted text, keeping the HEAD.
 *
 * Head rather than tail: a page's substance follows its title, whereas the tail
 * is usually related-links and boilerplate. Dropped characters are reported so
 * the caller can raise the limit deliberately instead of assuming completeness.
 */
export function capFetchText(
	text: string,
	maxChars: number = FETCH_CAPS.textChars,
): ShapedFetch {
	if (maxChars <= 0 || text.length <= maxChars) {
		return { text, droppedChars: 0, truncated: false };
	}
	const dropped = text.length - maxChars;
	return {
		text: `${text.slice(0, maxChars)}\n…[+${dropped} chars truncated — raise max_chars or use ctx_fetch_and_index]`,
		droppedChars: dropped,
		truncated: true,
	};
}

/**
 * Turn a response body into text according to its content type.
 * Only HTML gets tag stripping; JSON and plain text pass through so structured
 * data is not mangled.
 */
export function bodyToText(body: string, contentType: string): string {
	const ct = contentType.toLowerCase();
	if (ct.includes("html")) return htmlToText(body);
	if (ct.includes("json")) {
		try {
			return JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			// Content-Type claimed JSON but the body is not parseable; return it raw
			// rather than failing the fetch.
			return body.trim();
		}
	}
	return body.trim();
}
