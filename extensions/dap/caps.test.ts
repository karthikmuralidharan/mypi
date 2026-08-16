/**
 * Unit tests for output caps.
 *
 * These exist because the cap logic is the difference between a usable debugger
 * and one that destroys the context window. Upstream (and oh-my-pi) have no caps
 * at all, so there is no reference behaviour to fall back on — the invariants
 * below ARE the specification.
 *
 * Run: bun test extensions/dap
 */

import { describe, expect, test } from "bun:test";
import { CAPS, capList, capListText, capOutputTail, capValue } from "./caps";

describe("capValue", () => {
	test("leaves short values untouched", () => {
		expect(capValue("hello")).toBe("hello");
	});

	test("leaves a value exactly at the limit untouched (no off-by-one)", () => {
		const exact = "x".repeat(CAPS.valueChars);
		expect(capValue(exact)).toBe(exact);
	});

	test("truncates and reports the dropped character count", () => {
		const out = capValue("y".repeat(250), 200);
		expect(out.startsWith("y".repeat(200))).toBe(true);
		expect(out).toEndWith("…[+50 chars]");
	});

	test("marker is distinguishable from a literal ellipsis in program data", () => {
		// A bare "…" could be real program output; "…[+N chars]" cannot be mistaken.
		const out = capValue("a".repeat(300), 10);
		expect(out).toContain("…[+290 chars]");
		expect(capValue("a…b", 100)).toBe("a…b"); // literal ellipsis survives intact
	});

	test("max of 0 or less disables truncation rather than erasing the value", () => {
		expect(capValue("abc", 0)).toBe("abc");
		expect(capValue("abc", -1)).toBe("abc");
	});
});

describe("capList", () => {
	const render = (n: number) => `  item ${n}`;

	test("returns the empty placeholder for an empty list", () => {
		const r = capList([], render, "(none)");
		expect(r.text).toBe("(none)");
		expect(r).toMatchObject({ shown: 0, total: 0, truncated: false });
	});

	test("renders every item when under the cap", () => {
		const r = capList([1, 2, 3], render, "(none)");
		expect(r.text.split("\n")).toHaveLength(3);
		expect(r).toMatchObject({ shown: 3, total: 3, truncated: false });
	});

	test("caps item count and states how many were omitted", () => {
		const r = capList(
			Array.from({ length: 187 }, (_, i) => i),
			render,
			"(none)",
			{
				maxItems: 50,
			},
		);
		expect(r).toMatchObject({ shown: 50, total: 187, truncated: true });
		// The count must be actionable, not a vague "truncated".
		expect(r.text).toContain("… 137 more (showing 50 of 187)");
	});

	test("total-size backstop catches few-but-enormous items", () => {
		// The failure mode item-count alone misses: 5 items x 5000 chars = 25KB.
		const fat = Array.from({ length: 5 }, () => "z".repeat(5000));
		const r = capList(fat, (s) => s, "(none)", { maxItems: 50, maxTotal: 8000 });
		expect(r.truncated).toBe(true);
		expect(r.shown).toBeLessThan(5);
		expect(r.text.length).toBeLessThan(14_000);
	});

	test("always emits at least one item, even if it alone exceeds the backstop", () => {
		// Returning nothing would be worse than returning one oversized entry.
		const r = capList(["q".repeat(50_000), "second"], (s) => s, "(none)", {
			maxTotal: 100,
		});
		expect(r.shown).toBe(1);
		expect(r.truncated).toBe(true);
	});

	test("does not render items beyond the count cap", () => {
		let calls = 0;
		capList(
			Array.from({ length: 1000 }, (_, i) => i),
			(n) => {
				calls++;
				return `  ${n}`;
			},
			"(none)",
			{ maxItems: 10 },
		);
		// A huge tail must cost nothing to format.
		expect(calls).toBe(10);
	});

	test("capListText is the text of capList", () => {
		const items = [1, 2, 3];
		expect(capListText(items, render, "(none)")).toBe(
			capList(items, render, "(none)").text,
		);
	});
});

describe("capOutputTail", () => {
	test("returns short output unchanged with nothing dropped", () => {
		expect(capOutputTail("hello")).toEqual({ text: "hello", droppedBytes: 0 });
	});

	test("keeps the most recent bytes, not the earliest", () => {
		// Recency matters: `output` is polled after each step.
		const r = capOutputTail("A".repeat(100) + "TAIL", 10);
		expect(r.text).toEndWith("TAIL");
		expect(r.droppedBytes).toBe(94);
	});

	test("reports dropped bytes so the caller knows to raise the limit", () => {
		const r = capOutputTail("x".repeat(20_000), 8_000);
		expect(r.droppedBytes).toBe(12_000);
		expect(Buffer.byteLength(r.text, "utf-8")).toBeLessThanOrEqual(8_000);
	});

	test("counts bytes not characters for multi-byte output", () => {
		// "€" is 3 bytes; a char-based limit would under-cap by 3x.
		const euros = "€".repeat(100); // 300 bytes
		const r = capOutputTail(euros, 30);
		expect(Buffer.byteLength(r.text, "utf-8")).toBeLessThanOrEqual(30);
		expect(r.droppedBytes).toBe(270);
	});

	test("does not emit replacement characters when slicing mid-code-point", () => {
		// Cutting a 3-byte char at a 1-byte offset must drop the partial char,
		// not surface U+FFFD garbage the model would reason about as real data.
		const r = capOutputTail("€".repeat(10), 8); // 8 is not a multiple of 3
		expect(r.text).not.toContain("\uFFFD");
	});

	test("limit of 0 or less disables capping", () => {
		const long = "x".repeat(1000);
		expect(capOutputTail(long, 0)).toEqual({ text: long, droppedBytes: 0 });
	});
});

describe("CAPS defaults are sane", () => {
	test("worst-case variables payload stays bounded", () => {
		// listItems x valueChars is the theoretical ceiling before the total
		// backstop applies; assert the backstop is the binding constraint.
		expect(CAPS.totalChars).toBeLessThan(CAPS.listItems * CAPS.valueChars);
	});

	test("every cap is positive", () => {
		for (const [k, v] of Object.entries(CAPS)) {
			expect(v, `${k} must be positive`).toBeGreaterThan(0);
		}
	});
});
