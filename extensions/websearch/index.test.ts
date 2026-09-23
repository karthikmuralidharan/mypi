/**
 * Tests for loadResearchConfig's baseUrl resolution.
 *
 * Guards against the regression this shipped with: the old fallback read
 * ~/.pi/agent/extensions/aperture.json, the standing Aperture extension's
 * own config. Once that extension was retired, the fallback silently had
 * nowhere to read from, and web_research broke with no baseUrl configured.
 * Replaced by $APERTURE_GATEWAY_HOST -- the same canonical gateway host
 * config/fish/aperture-gateway.fish exports for pi's amazon-bedrock
 * provider, so there is one place to change it rather than a copy per
 * consumer.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadResearchConfig } from "./index";

function withAgentDir(fn: (agentDir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websearch-config-"));
	fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
	const prev = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
}

describe("loadResearchConfig", () => {
	test("has no baseUrl when neither websearch.json nor $APERTURE_GATEWAY_HOST is set", () => {
		withAgentDir((dir) => {
			withEnv("APERTURE_GATEWAY_HOST", undefined, () => {
				expect(loadResearchConfig(dir).baseUrl).toBe("");
			});
		});
	});

	test("falls back to $APERTURE_GATEWAY_HOST when websearch.json sets no baseUrl", () => {
		withAgentDir((dir) => {
			withEnv("APERTURE_GATEWAY_HOST", "http://ai-gateway.example.ts.net", () => {
				expect(loadResearchConfig(dir).baseUrl).toBe("http://ai-gateway.example.ts.net");
			});
		});
	});

	test("websearch.json's own baseUrl wins over $APERTURE_GATEWAY_HOST", () => {
		withAgentDir((dir) => {
			fs.writeFileSync(
				path.join(dir, "extensions", "websearch.json"),
				JSON.stringify({ baseUrl: "http://own.example" }),
			);
			withEnv("APERTURE_GATEWAY_HOST", "http://ai-gateway.example.ts.net", () => {
				expect(loadResearchConfig(dir).baseUrl).toBe("http://own.example");
			});
		});
	});

	test("strips a trailing slash from either source", () => {
		withAgentDir((dir) => {
			withEnv("APERTURE_GATEWAY_HOST", "http://ai-gateway.example.ts.net/", () => {
				expect(loadResearchConfig(dir).baseUrl).toBe("http://ai-gateway.example.ts.net");
			});
		});
	});
});
