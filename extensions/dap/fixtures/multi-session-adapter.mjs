#!/usr/bin/env node
/**
 * Minimal fake adapter simulating vscode-js-debug's multi-session protocol,
 * for lifecycle.test.ts-style hermetic testing of session.ts's `startDebugging`
 * handling without depending on the real js-debug binary.
 *
 * Mirrors dapDebugServer.js's own behavior, verified by reading its (minified)
 * source directly at ~/.pi/dap-adapters/js-debug/src/dapDebugServer.js:
 *   - A "parent" connection's launch/attach responds immediately (it is a pure
 *     bootstrapper), then sends a `startDebugging` reverse request carrying a
 *     `configuration` with a `__pendingTargetId`.
 *   - A "child" connects SEPARATELY (a new TCP connection to the same port) and
 *     self-identifies by echoing that `__pendingTargetId` back in its OWN
 *     launch/attach arguments.
 *   - The child's launch/attach RESPONSE is deliberately withheld until it
 *     sends configurationDone on that same connection (dapDebugServer.js:
 *     `n.deferred.resolve({})` only fires after `await e.configurationDone()`).
 *     This is the exact gate whose absence in the client caused the real bug:
 *     `child.sendRequest(request, configuration)` never resolving.
 *   - Only the child ever reports real threads; the parent always answers `[]`
 *     (dapDebugServer.js: `r.on("threads",async()=>({threads:[]}))`).
 */

import net from "node:net";

const PORT = Number(process.argv[2]);
let seq = 0;

function frame(sock, msg) {
	const body = JSON.stringify({ seq: ++seq, ...msg });
	sock.write(
		`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
	);
}

const server = net.createServer((sock) => {
	let buf = Buffer.alloc(0);
	let isChild = false;
	let configurationDoneGate;

	sock.on("data", (chunk) => {
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
			if (msg.type !== "request") continue; // skips the client's startDebugging RESPONSE too

			if (msg.command === "initialize") {
				frame(sock, {
					type: "response",
					request_seq: msg.seq,
					command: "initialize",
					success: true,
					body: { supportsConfigurationDoneRequest: true },
				});
				setImmediate(() => frame(sock, { type: "event", event: "initialized" }));
			} else if (msg.command === "launch" || msg.command === "attach") {
				const args = msg.arguments ?? {};
				if (args.__pendingTargetId) {
					isChild = true;
					configurationDoneGate = () =>
						frame(sock, {
							type: "response",
							request_seq: msg.seq,
							command: msg.command,
							success: true,
							body: {},
						});
				} else {
					frame(sock, {
						type: "response",
						request_seq: msg.seq,
						command: msg.command,
						success: true,
						body: {},
					});
					const targetId = `target-${Math.random().toString(36).slice(2)}`;
					setImmediate(() => {
						frame(sock, {
							type: "request",
							seq: ++seq,
							command: "startDebugging",
							arguments: {
								request: "launch",
								configuration: { type: "pwa-node", __pendingTargetId: targetId },
							},
						});
					});
				}
			} else if (msg.command === "configurationDone") {
				frame(sock, {
					type: "response",
					request_seq: msg.seq,
					command: "configurationDone",
					success: true,
					body: {},
				});
				if (isChild) {
					configurationDoneGate?.();
					setImmediate(() =>
						frame(sock, {
							type: "event",
							event: "stopped",
							body: { reason: "breakpoint", threadId: 1, allThreadsStopped: true },
						}),
					);
				}
			} else if (msg.command === "threads") {
				frame(sock, {
					type: "response",
					request_seq: msg.seq,
					command: "threads",
					success: true,
					body: { threads: isChild ? [{ id: 1, name: "main" }] : [] },
				});
			} else if (msg.command === "disconnect" || msg.command === "terminate") {
				frame(sock, {
					type: "response",
					request_seq: msg.seq,
					command: msg.command,
					success: true,
					body: {},
				});
				setTimeout(() => sock.destroy(), 20);
			} else {
				frame(sock, {
					type: "response",
					request_seq: msg.seq,
					command: msg.command,
					success: false,
					message: `unsupported: ${msg.command}`,
				});
			}
		}
	});
});

server.listen(PORT, "127.0.0.1");
