#!/usr/bin/env node
/**
 * Minimal fixture for the PWD/symlink regression test in dap.test.ts.
 *
 * Reports process.env.PWD and process.cwd() back over stdio DAP framing so the
 * test can assert on DapClient.spawn's environment handling from the outside —
 * DapClient does not expose the underlying ChildProcess, so the fixture must
 * self-report rather than the test reaching into private state.
 */
let seq = 0;
function send(msg) {
	const body = JSON.stringify({ seq: ++seq, ...msg });
	process.stdout.write(
		`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
	);
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	for (;;) {
		const i = buf.indexOf("\r\n\r\n");
		if (i < 0) return;
		const m = /Content-Length: (\d+)/i.exec(buf.subarray(0, i).toString());
		if (!m) {
			buf = buf.subarray(i + 4);
			continue;
		}
		const len = Number(m[1]);
		const start = i + 4;
		if (buf.length < start + len) return;
		const raw = buf.subarray(start, start + len).toString();
		buf = buf.subarray(start + len);
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			continue;
		}
		if (msg.type !== "request" || msg.command !== "initialize") continue;
		send({
			type: "response",
			request_seq: msg.seq,
			command: "initialize",
			success: true,
			body: {},
		});
		send({
			type: "event",
			event: "env-report",
			body: { pwd: process.env.PWD ?? null, cwd: process.cwd() },
		});
	}
});
process.stdin.on("end", () => process.exit(0));
