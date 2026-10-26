/**
 * DO NOT DEPLOY. This is a record of a failed approach, kept so the next
 * attempt starts from the finding instead of repeating it.
 *
 * WHAT HAPPENED (2026-10-14): deploying this emptied every aperture provider.
 * `pi --list-models` reported "No models match pattern" for all 13 configured
 * models, and a restart would have left the session with no models at all.
 *
 * WHY: docs/custom-provider.md says "Registering only `baseUrl` or `headers`
 * for an existing provider preserves its built-in models." That sentence is
 * about pi's BUILT-IN providers, not ones defined in models.json. Registering
 * a same-named provider from an extension supersedes the models.json
 * definition entirely, and because this config declares no static `models`,
 * each provider resolved to an empty list. `refreshModels` also did not
 * populate the list in time for `--list-models`.
 *
 * WHAT A WORKING VERSION NEEDS:
 *   1. A static `models` seed on every provider, so it is never empty. The
 *      seed is the offline floor; `context.stored` is empty on first run.
 *   2. Established refresh timing. `refreshModels` evidently does not run
 *      before startup model selection; it likely needs `pi update --models`
 *      or another explicit trigger. Verify before relying on it.
 *   3. Testing in a throwaway PI_CODING_AGENT_DIR, never the live agent dir.
 *
 * Superseded by scripts/sync-aperture-models.py, which cannot leave you with
 * zero models and produces a reviewable diff.
 *
 * ---- original header below ----
 *
 * Aperture gateway model discovery.
 *
 * The gateway publishes its full catalogue at GET /v1/models, including context
 * windows, max output tokens and per-token pricing for input, output, cache
 * read and both cache-write tiers. Hand-maintaining that in models.json meant
 * it drifted: an audit on 2026-10-14 found 18 models the gateway served that
 * models.json did not list, including cheaper newer Opus and a 1M-context Haiku.
 *
 * This registers `refreshModels` for each aperture provider, which is pi's
 * native discovery hook (docs/custom-provider.md: "Discover models dynamically
 * -> A provider with refreshModels").
 *
 * Deliberately minimal: it does NOT declare baseUrl, apiKey or a static model
 * list for providers that already exist in models.json. Pi composes models.json
 * above a registered provider, so the credential and any pinned overrides stay
 * where they are and this only adds the live catalogue.
 *
 * `aperture-anthropic` is the exception -- it has no models.json block, so it
 * self-declares and registers only when APERTURE_API_KEY is set. It exposes the
 * MS Foundry Claude route, which prices ~9% below the Bedrock equivalents.
 */
import type { Api, ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// pi loads .ts extensions directly and runs them on Node, but this repo has no
// tsconfig covering extensions/, so `process` is otherwise unresolved here.
declare const process: { env: Record<string, string | undefined> };

const GATEWAY = process.env.APERTURE_GATEWAY ?? "http://ai.tail427a30.ts.net";
const CATALOG = `${GATEWAY}/v1/models`;

interface GatewayModel {
  id: string;
  display_name?: string;
  context_window_tokens?: number;
  max_output_tokens?: number;
  supported_endpoints?: string[];
  pricing?: Record<string, string>;
}

interface Route {
  provider: string;
  api: Api;
  baseUrl: string;
  /** Only models whose advertised endpoints match belong to this provider. */
  matches: (endpoints: string[]) => boolean;
  /** Self-declare (no models.json block to inherit credential from). */
  standalone?: boolean;
}

const ROUTES: Route[] = [
  {
    provider: "aperture-bedrock",
    api: "bedrock-converse-stream",
    baseUrl: `${GATEWAY}/bedrock`,
    matches: (eps) => eps.some((e) => e.startsWith("/bedrock/")),
  },
  {
    provider: "aperture-completions",
    api: "openai-completions",
    baseUrl: `${GATEWAY}/v1`,
    matches: (eps) => eps.includes("/v1/chat/completions"),
  },
  {
    provider: "aperture-responses",
    api: "openai-responses",
    baseUrl: `${GATEWAY}/v1`,
    matches: (eps) => eps.includes("/v1/responses"),
  },
  {
    provider: "aperture-anthropic",
    api: "anthropic-messages",
    baseUrl: `${GATEWAY}/v1`,
    matches: (eps) => eps.includes("/v1/messages"),
    standalone: true,
  },
];

/** per-token string -> per-million-token number, which is what pi's cost uses */
function perMillion(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n * 1e6 : 0;
}

function toModelConfig(m: GatewayModel, route: Route): ProviderModelConfig | null {
  const ctx = m.context_window_tokens;
  const out = m.max_output_tokens;
  // contextWindow and maxTokens are required; a model without them would
  // silently inherit pi's 128K/16K default and misreport its limits.
  if (!ctx || !out) return null;

  const p = m.pricing ?? {};
  const cost = {
    input: perMillion(p.input),
    output: perMillion(p.output),
    cacheRead: perMillion(p.input_cache_read),
    cacheWrite: perMillion(p.input_cache_write),
  };

  // Declaring promptCache is what makes a model eligible for cache warming.
  // Only claim the 1h tier when the gateway actually prices it.
  const promptCache: { short: number; long?: number } = { short: 300 };
  if (p.input_cache_write_1h) promptCache.long = 3600;

  return {
    id: m.id,
    name: m.display_name ?? m.id,
    api: route.api,
    baseUrl: route.baseUrl,
    input: ["text", "image"],
    cost,
    contextWindow: ctx,
    maxTokens: out,
    reasoning: true,
    promptCache,
  } as ProviderModelConfig;
}

async function fetchCatalogue(key: string | undefined, signal: AbortSignal): Promise<GatewayModel[]> {
  const headers = new Headers({ Accept: "application/json" });
  if (key) headers.set("Authorization", `Bearer ${key}`);
  const res = await fetch(CATALOG, { headers, signal });
  if (!res.ok) throw new Error(`${CATALOG} -> HTTP ${res.status}`);
  const body = (await res.json()) as { data?: GatewayModel[] };
  return body.data ?? [];
}

export default function apertureModels(pi: ExtensionAPI): void {
  for (const route of ROUTES) {
    if (route.standalone && !process.env.APERTURE_API_KEY) continue;

    const discovery = {
      async refreshModels(context: {
        credential?: { key?: string };
        stored?: { models?: readonly unknown[] };
        allowNetwork: boolean;
        signal: AbortSignal;
      }): Promise<ProviderModelConfig[]> {
        // Offline or cache-only startup: never return an empty list, or the
        // provider ends up with no models at all.
        if (!context.allowNetwork) {
          return (context.stored?.models ?? []) as ProviderModelConfig[];
        }

        const key = context.credential?.key ?? process.env.APERTURE_API_KEY;
        const all = await fetchCatalogue(key, context.signal);

        const seen = new Set<string>();
        const models: ProviderModelConfig[] = [];
        for (const m of all) {
          const eps = m.supported_endpoints ?? [];
          if (!route.matches(eps)) continue;
          // The gateway lists some ids twice under different upstreams; pi
          // requires unique ids per provider, so keep the first.
          if (seen.has(m.id)) continue;
          const cfg = toModelConfig(m, route);
          if (!cfg) continue;
          seen.add(m.id);
          models.push(cfg);
        }
        return models;
      },
    };

    // Providers that already exist in models.json inherit credential, baseUrl
    // and any pinned overrides from there; only the standalone one declares
    // its own, so nothing duplicates the gateway key into this tracked file.
    const config = route.standalone
      ? {
          ...discovery,
          name: "Aperture (Foundry Anthropic)",
          baseUrl: route.baseUrl,
          apiKey: "$APERTURE_API_KEY",
          api: route.api,
          authHeader: true,
        }
      : discovery;

    pi.registerProvider(route.provider, config);
  }
}
