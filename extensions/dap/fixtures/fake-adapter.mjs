#!/usr/bin/env node
/**
 * Deterministic fake DAP adapter for lifecycle tests.
 *
 * Speaks real DAP over stdio so session.ts is exercised through its actual
 * protocol path — no debugpy/dlv/js-debug required, no timing flakiness, and
 * failure paths (adapter crash, silent adapter, never-stops) become reproducible
 * instead of unobservable.
 *
 * Behaviour is selected by FAKE_DAP_MODE:
 *   normal          well-behaved: initialize -> initialized -> configurationDone
 *                   -> launch -> stopped(entry); continue -> stopped(breakpoint)
 *   no-config-done  reports supportsConfigurationDoneRequest: false
 *   silent-init     never answers initialize (exercises the init timeout)
 *   exit-on-launch  writes to stderr and exits 3 during launch
 *   no-stop         launches but never emits stopped (exercises the running fallback)
 *   slow-stop       emits stopped after FAKE_DAP_STOP_DELAY_MS (default 6000)
 *   noisy           emits a large volume of output events (exercises output caps)
 *
 * Kept in plain .mjs so it runs under bare node with no build step.
 */

const MODE = process.env.FAKE_DAP_MODE ?? "normal";
const STOP_DELAY = Number(process.env.FAKE_DAP_STOP_DELAY_MS ?? 6000);
const NOISY_LINES = Number(process.env.FAKE_DAP_NOISY_LINES ?? 2000);

let seq = 0;
function send(msg) {
	const body = JSON.stringify({ seq: ++seq, ...msg });
	process.stdout.write(
		`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
	);
}
const respond = (req, body, success = true, message) =>
	send({
		type: "response",
		request_seq: req.seq,
		command: req.command,
		success,
		...(message ? { message } : {}),
		...(body === undefined ? {} : { body }),
	});
const event = (name, body) =>
	send({ type: "event", event: name, ...(body === undefined ? {} : { body }) });

const THREAD = { id: 1, name: "fake-thread" };
const FRAMES = [
	{
		id: 1000,
		name: "main",
		line: 10,
		column: 1,
		source: { path: "/fake/app.py", name: "app.py" },
	},
	{
		id: 1001,
		name: "caller",
		line: 42,
		column: 1,
		source: { path: "/fake/app.py", name: "app.py" },
	},
];

function stopped(reason) {
	event("stopped", { reason, threadId: THREAD.id, allThreadsStopped: true });
}

const handlers = {
	initialize(req) {
		if (MODE === "silent-init") return; // deliberately no response
		respond(req, {
			supportsConfigurationDoneRequest: MODE !== "no-config-done",
			supportsFunctionBreakpoints: true,
			supportsEvaluateForHovers: true,
			supportsTerminateRequest: true,
		});
		// Real adapters emit `initialized` after the initialize response.
		setImmediate(() => event("initialized"));
	},

	setBreakpoints(req) {
		const bps = (req.arguments?.breakpoints ?? []).map((b, i) => ({
			id: i + 1,
			verified: true,
			line: b.line,
		}));
		respond(req, { breakpoints: bps });
	},

	setFunctionBreakpoints(req) {
		const bps = (req.arguments?.breakpoints ?? []).map((b, i) => ({
			id: i + 1,
			verified: true,
			name: b.name,
		}));
		respond(req, { breakpoints: bps });
	},

	configurationDone(req) {
		respond(req, {});
	},

	launch(req) {
		if (MODE === "exit-on-launch") {
			process.stderr.write("fake adapter: simulated launch failure\n");
			process.exit(3);
		}
		respond(req, {});
		if (MODE === "noisy") {
			for (let i = 0; i < NOISY_LINES; i++) {
				event("output", {
					category: "stdout",
					output: `line ${i} ${"x".repeat(80)}\n`,
				});
			}
		}
		if (MODE === "no-stop") return;
		if (MODE === "slow-stop")
			setTimeout(() => stopped("entry"), STOP_DELAY).unref?.();
		else setImmediate(() => stopped("entry"));
	},

	attach(req) {
		respond(req, {});
		setImmediate(() => stopped("entry"));
	},

	threads(req) {
		respond(req, { threads: [THREAD] });
	},

	stackTrace(req) {
		const levels = req.arguments?.levels;
		// Honour `levels` so the stack_trace depth cap is observable end-to-end.
		const frames =
			typeof levels === "number" && levels > 0 ? FRAMES.slice(0, levels) : FRAMES;
		respond(req, { stackFrames: frames, totalFrames: FRAMES.length });
	},

	scopes(req) {
		respond(req, {
			scopes: [{ name: "Locals", variablesReference: 2000, expensive: false }],
		});
	},

	variables(req) {
		const count = Number(process.env.FAKE_DAP_VAR_COUNT ?? 3);
		const width = Number(process.env.FAKE_DAP_VAR_WIDTH ?? 5);
		const vars = Array.from({ length: count }, (_, i) => ({
			name: `v${i}`,
			value: "V".repeat(width),
			type: "str",
			variablesReference: 0,
		}));
		respond(req, { variables: vars });
	},

	evaluate(req) {
		respond(req, {
			result: `evaluated(${req.arguments?.expression})`,
			type: "str",
		});
	},

	continue(req) {
		respond(req, { allThreadsContinued: true });
		if (MODE === "no-stop") return;
		setImmediate(() => stopped("breakpoint"));
	},

	next(req) {
		respond(req, {});
		setImmediate(() => stopped("step"));
	},
	stepIn(req) {
		respond(req, {});
		setImmediate(() => stopped("step"));
	},
	stepOut(req) {
		respond(req, {});
		setImmediate(() => stopped("step"));
	},

	pause(req) {
		respond(req, {});
		setImmediate(() => stopped("pause"));
	},

	terminate(req) {
		respond(req, {});
		event("terminated");
		setTimeout(() => process.exit(0), 20).unref?.();
	},

	disconnect(req) {
		respond(req, {});
		setTimeout(() => process.exit(0), 20).unref?.();
	},
};

// ── stdio DAP framing ────────────────────────────────────────────────────────
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
		// A malformed frame must be skipped, not throw. An uncaught parse error here
		// would kill the fixture mid-test and surface as a confusing "adapter
		// exited" failure rather than the protocol error it actually is.
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			process.stderr.write(
				`fake adapter: skipped malformed frame (${len} bytes)\n`,
			);
			continue;
		}
		if (msg.type !== "request") continue;
		const h = handlers[msg.command];
		if (h) h(msg);
		else respond(msg, undefined, false, `unsupported: ${msg.command}`);
	}
});

process.stdin.on("end", () => process.exit(0));
