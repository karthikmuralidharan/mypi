/**
 * Tests for web_fetch shaping.
 *
 * The failure these guard against is concrete: rpiv-web-tools' web_fetch
 * returned raw pages including navigation chrome — 21KB to answer one question.
 * Measured on go.dev/doc/devel/release, this module takes 145,410 HTML chars to
 * 10,071 returned (93.1% reduction) with the nav tree gone.
 */

import { describe, expect, test } from "bun:test";
import {
	assertHttpUrl,
	bodyToText,
	capFetchText,
	FETCH_CAPS,
	htmlToText,
} from "./fetch";

describe("assertHttpUrl", () => {
	test("accepts http and https", () => {
		expect(assertHttpUrl("https://a.example/x").protocol).toBe("https:");
		expect(assertHttpUrl("http://a.example").protocol).toBe("http:");
	});

	test("rejects non-http schemes that would widen an outbound sink", () => {
		for (const bad of [
			"file:///etc/passwd",
			"data:text/html,x",
			"ftp://a.example",
		]) {
			expect(() => assertHttpUrl(bad)).toThrow(/must be http/);
		}
	});

	test("rejects unparseable input with the label in the message", () => {
		expect(() => assertHttpUrl("not a url", "baseUrl")).toThrow(
			/baseUrl is not a valid URL/,
		);
	});
});

describe("htmlToText", () => {
	test("drops script and style content entirely", () => {
		const t = htmlToText(
			"<style>.a{color:red}</style><script>evil()</script><p>keep</p>",
		);
		expect(t).toBe("keep");
	});

	test("drops navigation chrome, which is the whole point", () => {
		const t = htmlToText(
			"<nav><a>Home</a><a>Docs</a></nav><h1>Title</h1><p>Body</p><footer>(c) 2026</footer>",
		);
		expect(t).toContain("Title");
		expect(t).toContain("Body");
		expect(t).not.toContain("Home");
		expect(t).not.toContain("2026");
	});

	test("turns block tags into line breaks instead of losing them", () => {
		expect(
			htmlToText("<p>one</p><p>two</p>").split("\n").filter(Boolean),
		).toEqual(["one", "two"]);
	});

	test("decodes named and numeric entities", () => {
		expect(htmlToText("<p>a &amp; b &lt;c&gt; &#65; &#x42;</p>")).toBe(
			"a & b <c> A B",
		);
	});

	test("collapses runs of blank lines and trims whitespace", () => {
		expect(htmlToText("<p>a</p><div></div><div></div><p>b</p>")).toBe("a\n\nb");
	});

	test("handles unclosed and malformed tags without throwing", () => {
		expect(htmlToText("<p>text<div><span>more")).toContain("text");
	});
});

describe("capFetchText", () => {
	test("returns short text unchanged", () => {
		expect(capFetchText("short")).toEqual({
			text: "short",
			droppedChars: 0,
			truncated: false,
		});
	});

	test("keeps the head, since a page's substance follows its title", () => {
		const r = capFetchText("HEAD" + "x".repeat(100), 10);
		expect(r.text.startsWith("HEAD")).toBe(true);
		expect(r.truncated).toBe(true);
	});

	test("states the dropped count and names the escape hatch", () => {
		const r = capFetchText("y".repeat(50), 10);
		expect(r.droppedChars).toBe(40);
		expect(r.text).toContain("+40 chars truncated");
		// Silent truncation would let the model conclude from a partial page.
		expect(r.text).toContain("ctx_fetch_and_index");
	});

	test("a limit of 0 or less disables capping", () => {
		const long = "z".repeat(200);
		expect(capFetchText(long, 0).text).toBe(long);
	});

	test("default cap is the documented one", () => {
		expect(capFetchText("q".repeat(FETCH_CAPS.textChars + 1)).truncated).toBe(
			true,
		);
	});
});

describe("bodyToText", () => {
	test("strips tags only for HTML content types", () => {
		expect(bodyToText("<p>hi</p>", "text/html; charset=utf-8")).toBe("hi");
	});

	test("pretty-prints JSON rather than mangling it", () => {
		expect(bodyToText('{"a":1}', "application/json")).toBe('{\n  "a": 1\n}');
	});

	test("returns unparseable JSON raw instead of failing the fetch", () => {
		expect(bodyToText("{not json", "application/json")).toBe("{not json");
	});

	test("passes plain text through untouched apart from trimming", () => {
		expect(bodyToText("  plain <b>kept</b>  ", "text/plain")).toBe(
			"plain <b>kept</b>",
		);
	});
});
