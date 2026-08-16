/**
 * Output caps for debug results.
 *
 * WHY THIS FILE EXISTS: neither oh-my-pi nor the @piex-dev/dap port caps
 * debugger output. Verified in OMP: the only limit is a 128KB stdout ring, and
 * `debug.ts` calls `getOutput()` with no argument, so one `action:"output"` can
 * push 128KB into the context window. `variables`, `scopes`, `stack_trace`,
 * `modules` and `disassemble` forward the adapter response verbatim with no
 * breadth, depth or length limit at all.
 *
 * A debugger is the single most output-heavy tool an agent can hold: one
 * `variables` call on a large scope, or one `output` call after a chatty loop,
 * can cost more context than the entire rest of the session.
 *
 * Design rules:
 *  - Never silently drop. Every elision states what was omitted, so the model
 *    can decide whether to narrow the query rather than assuming it saw
 *    everything. Silent truncation causes wrong conclusions; loud truncation
 *    just costs a follow-up call.
 *  - Cap on two axes. Item count alone is not enough (50 items x 10KB values is
 *    still catastrophic), and total size alone loses the shape of the data.
 */

export const CAPS = {
	/** Max entries rendered from any list-shaped result. */
	listItems: 50,
	/** Max characters for a single rendered value (e.g. one variable). */
	valueChars: 200,
	/** Total character backstop for one rendered list, after per-item caps. */
	totalChars: 8_000,
	/** Default `stack_trace` depth when the caller does not specify one. */
	stackFrames: 20,
	/** Bytes of captured stdout/stderr returned by `action:"output"`. */
	outputBytes: 8 * 1024,
} as const;

/**
 * Truncate a single value, stating how many characters were dropped.
 * `…[+N chars]` mirrors OMP's minimizer convention, which deliberately differs
 * from a bare `…` so the model can tell a truncation marker from a literal
 * ellipsis in program data.
 */
export function capValue(value: string, max: number = CAPS.valueChars): string {
	if (max <= 0 || value.length <= max) return value;
	const dropped = value.length - max;
	return `${value.slice(0, max)}…[+${dropped} chars]`;
}

export interface CapListResult {
	text: string;
	shown: number;
	total: number;
	truncated: boolean;
}

/**
 * Render a list under both an item-count cap and a total-size backstop.
 *
 * `render` is applied only to items that survive the count cap, so a huge tail
 * costs nothing to format.
 */
export function capList<T>(
	items: readonly T[],
	render: (item: T, index: number) => string,
	empty: string,
	opts: { maxItems?: number; maxTotal?: number } = {},
): CapListResult {
	const maxItems = opts.maxItems ?? CAPS.listItems;
	const maxTotal = opts.maxTotal ?? CAPS.totalChars;
	const total = items.length;
	if (total === 0) return { text: empty, shown: 0, total: 0, truncated: false };

	const lines: string[] = [];
	let used = 0;
	let shown = 0;
	for (let i = 0; i < Math.min(total, maxItems); i++) {
		const line = render(items[i], i);
		// Stop before exceeding the backstop, but always emit at least one line so
		// a single oversized entry still yields something inspectable.
		if (shown > 0 && used + line.length > maxTotal) break;
		lines.push(line);
		used += line.length + 1;
		shown++;
	}

	const truncated = shown < total;
	if (truncated) {
		lines.push(`  … ${total - shown} more (showing ${shown} of ${total})`);
	}
	return { text: lines.join("\n"), shown, total, truncated };
}

/** Convenience wrapper for the common case where only the text is needed. */
export function capListText<T>(
	items: readonly T[],
	render: (item: T, index: number) => string,
	empty: string,
	opts?: { maxItems?: number; maxTotal?: number },
): string {
	return capList(items, render, empty, opts).text;
}

export interface CapOutputResult {
	text: string;
	droppedBytes: number;
}

/**
 * Return the tail of captured program output.
 *
 * Tail rather than head+tail: `output` is polled repeatedly during a stepping
 * session, so the most recent bytes are what the agent is reasoning about. The
 * dropped-byte count is reported so the model knows earlier output exists and
 * can raise the limit deliberately.
 */
export function capOutputTail(
	output: string,
	maxBytes: number = CAPS.outputBytes,
): CapOutputResult {
	const buf = Buffer.from(output, "utf-8");
	if (maxBytes <= 0 || buf.length <= maxBytes)
		return { text: output, droppedBytes: 0 };

	// Advance to a code-point boundary before decoding. A non-streaming
	// TextDecoder does NOT silently drop a leading partial code point — it emits
	// U+FFFD for each stray continuation byte, which the model would then read as
	// real program output. Skip bytes matching 0b10xxxxxx (0x80–0xBF).
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;

	const text = new TextDecoder("utf-8").decode(buf.subarray(start));
	// Report the bytes actually dropped, which may exceed maxBytes by up to 3 once
	// the boundary adjustment is applied.
	return { text, droppedBytes: start };
}
