/**
 * Tests for web_research's configuration and registry resolution.
 *
 * The tool takes a "provider/model-id" reference into pi's own model
 * registry (models.json) and resolves endpoint + credentials through it, so
 * the gateway host has exactly one definition. resolveResearchTarget is
 * tested against a fake ResearchRegistry — no pi runtime needed.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	loadResearchConfig,
	parseModelRef,
	resolveResearchTarget,
	type ResearchAuth,
	type ResearchRegistry,
} from "./index";

function withAgentDir(fn: (agentDir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websearch-config-"));
	fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function writeConfig(dir: string, json: string): void {
	fs.writeFileSync(path.join(dir, "extensions", "websearch.json"), json);
}

describe("loadResearchConfig", () => {
	test("defaults to the aperture-responses registry reference", () => {
		withAgentDir((dir) => {
			const cfg = loadResearchConfig(dir);
			expect(cfg.model).toBe("aperture-responses/gpt-5.6-luna");
			expect(cfg.timeoutMs).toBe(120_000);
		});
	});

	test("reads model and timeoutMs from websearch.json", () => {
		withAgentDir((dir) => {
			writeConfig(dir, JSON.stringify({ model: "other/ref", timeoutMs: 5000 }));
			const cfg = loadResearchConfig(dir);
			expect(cfg.model).toBe("other/ref");
			expect(cfg.timeoutMs).toBe(5000);
		});
	});

	test("a baseUrl key in websearch.json is inert", () => {
		withAgentDir((dir) => {
			writeConfig(dir, JSON.stringify({ baseUrl: "http://legacy.example" }));
			expect(loadResearchConfig(dir).model).toBe("aperture-responses/gpt-5.6-luna");
		});
	});

	test("broken JSON falls back to defaults", () => {
		withAgentDir((dir) => {
			writeConfig(dir, "{ not json");
			expect(loadResearchConfig(dir).model).toBe("aperture-responses/gpt-5.6-luna");
		});
	});
});

describe("parseModelRef", () => {
	test("splits on the first slash", () => {
		expect(parseModelRef("aperture-responses/gpt-5.6-luna")).toEqual({
			provider: "aperture-responses",
			id: "gpt-5.6-luna",
		});
	});

	test("rejects refs without both parts", () => {
		expect(parseModelRef("noslash")).toBeUndefined();
		expect(parseModelRef("/id")).toBeUndefined();
		expect(parseModelRef("provider/")).toBeUndefined();
	});
});

// Minimal registry-double model; only the fields resolution reads matter.
function fakeModel(over: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-5.6-luna",
		name: "gpt-5.6-luna",
		api: "openai-responses",
		provider: "aperture-responses",
		baseUrl: "http://gw.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...over,
	};
}

function fakeRegistry(
	models: Record<string, Model<Api>>,
	auth: ResearchAuth = { ok: true, apiKey: "test-key" },
): ResearchRegistry {
	return {
		find: (provider, id) => models[`${provider}/${id}`],
		getApiKeyAndHeaders: async () => auth,
	};
}

const REF = "aperture-responses/gpt-5.6-luna";
const KNOWN = { [REF]: fakeModel() };

describe("resolveResearchTarget", () => {
	test("resolves endpoint and auth from the owning provider", async () => {
		const target = await resolveResearchTarget(fakeRegistry(KNOWN), REF);
		expect(target.endpoint.href).toBe("http://gw.example/v1/responses");
		expect(target.modelId).toBe("gpt-5.6-luna");
		expect(target.headers["content-type"]).toBe("application/json");
		expect(target.headers.authorization).toBe("Bearer test-key");
	});

	test("unknown and malformed refs get an actionable error", async () => {
		await expect(resolveResearchTarget(fakeRegistry({}), REF)).rejects.toThrow(
			/not a provider\/model reference/,
		);
		await expect(resolveResearchTarget(fakeRegistry(KNOWN), "noslash")).rejects.toThrow(
			/not a provider\/model reference/,
		);
	});

	test("rejects models that do not speak the Responses API", async () => {
		const registry = fakeRegistry({
			"bedrock/claude": fakeModel({
				id: "claude",
				provider: "bedrock",
				api: "bedrock-converse-stream",
			}),
		});
		await expect(resolveResearchTarget(registry, "bedrock/claude")).rejects.toThrow(
			/openai-responses/,
		);
	});

	test("surfaces credential resolution failures", async () => {
		const registry = fakeRegistry(KNOWN, { ok: false, error: "no api key" });
		await expect(resolveResearchTarget(registry, REF)).rejects.toThrow(
			/cannot resolve credentials.*no api key/,
		);
	});

	test("an auth-resolved baseUrl overrides the provider's", async () => {
		const registry = fakeRegistry(KNOWN, {
			ok: true,
			baseUrl: "http://override.example/v1/",
		});
		const target = await resolveResearchTarget(registry, REF);
		expect(target.endpoint.href).toBe("http://override.example/v1/responses");
	});

	test("provider headers pass through; null unsets; own Authorization wins", async () => {
		const registry = fakeRegistry(KNOWN, {
			ok: true,
			apiKey: "test-key",
			headers: { "x-org": "acme", "content-type": null, authorization: "Token abc" },
		});
		const target = await resolveResearchTarget(registry, REF);
		expect(target.headers["x-org"]).toBe("acme");
		expect(target.headers["content-type"]).toBeUndefined();
		expect(target.headers.authorization).toBe("Token abc");
	});
});
