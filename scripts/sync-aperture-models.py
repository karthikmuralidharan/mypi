#!/usr/bin/env python3
"""Regenerate the aperture provider model lists in config/models.json.

The gateway publishes its catalogue at GET /v1/models with context windows,
max output tokens and per-token pricing. Sync the Anthropic Messages and
OpenAI Responses providers from their advertised endpoints.

Design notes, learned the hard way:

* Provider-level fields (baseUrl, apiKey, api) are never touched. Only each
  provider's `models` array is regenerated.
* Existing per-model entries are MERGED, not replaced. The gateway does not
  publish `input` or `reasoning`, so hand-set values survive and only
  contextWindow, maxTokens, name and cost are refreshed from upstream.
* A provider is only written if it ends up with at least one model. An empty
  models array makes every `enabledModels` pattern match nothing, which leaves
  pi with no usable model at all.
* `promptCache` is derived from the pricing the gateway publishes, not
  hardcoded. A model is declared cache-capable only when it prices
  `input_cache_read`, and the 1h tier is claimed only when
  `input_cache_write_1h` exists. Declaring a lifetime is what makes a model
  eligible for cache warming (docs/settings.md, `cacheWarming`).
* Models are assigned to a provider by their advertised `supported_endpoints`,
  not by guessing from the id. A model declared under the wrong api registers
  fine and then fails at request time. A catalogue entry does not guarantee
  that the current user can access the model.

Usage:
  scripts/sync-aperture-models.py            # update config/models.json
  scripts/sync-aperture-models.py --check    # exit 1 if out of date (no write)
  scripts/sync-aperture-models.py --deploy   # also copy to ~/.pi/agent
"""
import argparse
import json
import re
import shutil
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MODELS_JSON = REPO / "config" / "models.json"
LIVE = Path.home() / ".pi/agent/models.json"
CA = Path.home() / ".config/certs/cato-root.pem"

# Provider name -> gateway endpoint. These are the providers in models.json.
ROUTES = {
    "anthropic": "/v1/messages",
    "openai": "/v1/responses",
}


def per_million(v):
    try:
        return round(float(v) * 1e6, 6)
    except (TypeError, ValueError):
        return None


def _http_only_opener(ctx):
    """An opener with only HTTP(S) handlers.

    `urlopen` and `build_opener` both carry a FileHandler, so a `file:` or
    custom scheme in baseUrl could turn a catalogue fetch into a local-file
    read. Building the OpenerDirector by hand makes that structurally
    impossible rather than merely checked.
    """
    opener = urllib.request.OpenerDirector()
    opener.add_handler(urllib.request.HTTPHandler())
    opener.add_handler(urllib.request.HTTPSHandler(context=ctx))
    opener.add_handler(urllib.request.HTTPRedirectHandler())
    opener.add_handler(urllib.request.HTTPErrorProcessor())
    return opener


def fetch(base_url, api_key):
    url = base_url.rstrip("/") + "/models"
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        print(f"refusing non-http(s) gateway URL: {url}", file=sys.stderr)
        sys.exit(2)
    # Scheme validated above, and _http_only_opener carries no FileHandler,
    # so file: and custom schemes cannot be reached from here.
    req = urllib.request.Request(  # noqa: S310
        url,
        headers={"Accept": "application/json",
                 "Authorization": f"Bearer {api_key}"},
    )
    ctx = None
    if CA.exists():
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(str(CA))
    try:
        with _http_only_opener(ctx).open(req, timeout=30) as r:
            return json.loads(r.read())["data"]
    except (urllib.error.URLError, OSError, KeyError, json.JSONDecodeError) as e:
        print(f"cannot read gateway catalogue at {url}: {e}", file=sys.stderr)
        print("is the tailnet up?", file=sys.stderr)
        sys.exit(2)


def is_complete(gw):
    """Does the gateway describe this model well enough to configure it?

    A bare `{"id": ...}` entry is worse than absent: pi falls back to a uniform
    128K/16K default and zero cost, so limits are wrong and spend on that model
    silently reports as free. The gateway publishes ids before their metadata
    is filled in, so skip those until it catches up.
    """
    pricing = gw.get("pricing") or {}
    return bool(gw.get("context_window_tokens")
                and gw.get("max_output_tokens")
                and pricing.get("input")
                and pricing.get("output"))


# Claude sonnet/opus/haiku support extended thinking, but the gateway publishes
# no capability flag for it. Without `reasoning: true` pi treats the model as
# non-thinking and `/thinking` offers no levels at all, so a newly discovered
# Claude model silently loses level switching. Seed it for these three families
# only -- `claude-fable-*` is not a family whose thinking support is verified.
# GPT capability flags are left unchanged.
CLAUDE_REASONING_RE = re.compile(r"^(?:us\.anthropic\.)?claude-(sonnet|opus|haiku)-")


def seeds_reasoning(model_id):
    """True when a NEW entry for this id should declare extended thinking."""
    return bool(CLAUDE_REASONING_RE.search(model_id))


def build_entry(gw, existing):
    """Gateway fields overlay an existing entry; hand-set fields survive.

    Only fields the gateway actually publishes are written. `input` is never
    invented: the existing gpt-* entries omit it and work, so defaulting it
    would assert image support upstream never claimed. `reasoning` is the one
    exception, and only on creation for the Claude families above, because a
    missing flag is not a neutral omission -- it removes `/thinking` entirely.
    """
    out = OrderedDict(existing) if existing else OrderedDict()
    out["id"] = gw["id"]
    # Creation only: an existing entry's value is deliberate either way.
    if existing is None and seeds_reasoning(gw["id"]):
        out["reasoning"] = True
    if gw.get("display_name"):
        out["name"] = gw["display_name"]
    if gw.get("context_window_tokens"):
        out["contextWindow"] = gw["context_window_tokens"]
    if gw.get("max_output_tokens"):
        out["maxTokens"] = gw["max_output_tokens"]

    pricing = gw.get("pricing") or {}
    cost = OrderedDict(out.get("cost") or {})
    for key, field in (("input", "input"), ("output", "output"),
                       ("cacheRead", "input_cache_read"),
                       ("cacheWrite", "input_cache_write")):
        v = per_million(pricing.get(field))
        if v is not None:
            cost[key] = v
    if cost:
        out["cost"] = cost

    # Cache warming only runs for a model that declares a lifetime, so derive
    # one from what the gateway actually prices. `input_cache_read` is the
    # evidence that a prefix cache exists at all; 300s is the conservative end
    # of the short tier. Claim 1h only where the gateway prices it, which on
    # this gateway is the Bedrock Anthropic models.
    if pricing.get("input_cache_read"):
        pc = {"short": 300}
        if pricing.get("input_cache_write_1h"):
            pc["long"] = 3600
        out["promptCache"] = pc
    return out


def previous_entry(mid, have):
    """Preserve settings when an old Bedrock ID maps unambiguously to an alias."""
    if mid in have:
        return have[mid]
    matches = [entry for old, entry in have.items()
               if old.startswith("us.anthropic.")
               and (old[len("us.anthropic."):] == mid
                    or re.fullmatch(re.escape(mid) + r"(?:-\d{8})?-v\d+(?::\d+)?",
                                    old[len("us.anthropic."):]))]
    return matches[0] if len(matches) == 1 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="report drift and exit 1; write nothing")
    ap.add_argument("--deploy", action="store_true",
                    help="also copy the result to ~/.pi/agent/models.json")
    a = ap.parse_args()

    try:
        with open(MODELS_JSON, encoding="utf-8") as fh:
            doc = json.load(fh, object_pairs_hook=OrderedDict)
    except (OSError, json.JSONDecodeError) as e:
        print(f"cannot read {MODELS_JSON}: {e}", file=sys.stderr)
        return 2

    providers = doc.get("providers") or {}
    src = providers.get("openai")
    if not src:
        print("no openai provider to read the Aperture catalogue from",
              file=sys.stderr)
        return 2

    catalogue = fetch(src["baseUrl"], src["apiKey"])
    by_id = {}
    for m in catalogue:
        by_id.setdefault(m["id"], m)   # gateway lists some ids twice
    print(f"gateway: {len(catalogue)} records, {len(by_id)} distinct ids")

    added, updated, removed, incomplete, unmatched = {}, {}, {}, [], []
    for name, endpoint in ROUTES.items():
        prov = providers.get(name)
        if prov is None:
            continue
        have = OrderedDict((m["id"], m) for m in prov.get("models") or [])
        rebuilt, new_ids, changed = [], [], []
        for mid, gw in sorted(by_id.items()):
            if endpoint not in (gw.get("supported_endpoints") or []):
                continue
            # Never introduce a model the gateway has not described. An entry
            # already in models.json is kept as-is, since merging only
            # overlays fields that are actually published.
            if mid not in have and not is_complete(gw):
                incomplete.append(f"{name}/{mid}")
                continue
            entry = build_entry(gw, previous_entry(mid, have))
            if mid not in have:
                new_ids.append(mid)
            elif entry != have[mid]:
                # record which fields moved, so a price change is not
                # indistinguishable from a display-name backfill
                fields = sorted(k for k in set(entry) | set(have[mid])
                                if entry.get(k) != have[mid].get(k))
                changed.append((mid, fields))
            rebuilt.append(entry)

        if not rebuilt:
            print(f"  {name}: gateway matched 0 models — keeping existing "
                  f"{len(have)} rather than emptying the provider",
                  file=sys.stderr)
            unmatched.append(name)
            continue
        missing = sorted(set(have) - {entry["id"] for entry in rebuilt})
        if missing:
            removed[name] = missing
        prov["models"] = rebuilt
        if new_ids:
            added[name] = new_ids
        if changed:
            updated[name] = changed

    print("\n=== added ===")
    for name, ids in added.items() or ():
        for i in ids:
            print(f"  {name}/{i}")
    if not added:
        print("  (none)")

    print("\n=== field changes on existing models ===")
    for name, entries in updated.items() or ():
        for mid, fields in entries:
            print(f"  {name}/{mid}: {', '.join(fields)}")
    if not updated:
        print("  (none)")

    print("\n=== removed (not advertised for this endpoint) ===")
    for name, ids in removed.items():
        for mid in ids:
            print(f"  {name}/{mid}")
    if not removed:
        print("  (none)")

    if incomplete:
        print(f"\n=== skipped, gateway metadata incomplete ({len(incomplete)}) ===")
        print("  No context window, max output or pricing published yet.")
        print("  Re-run once the gateway fills them in.")
        for i in incomplete:
            print(f"    {i}")

    if a.check:
        drift = bool(added or updated or removed or unmatched)
        print(f"\n--check: {'DRIFT' if drift else 'up to date'}")
        return 1 if drift else 0

    if unmatched:
        print("\nrefusing to write: a provider matched no models", file=sys.stderr)
        return 2

    if not (added or updated or removed):
        print("\nnothing to write")
        if a.deploy:
            shutil.copy2(MODELS_JSON, LIVE)
            print(f"deployed to {LIVE}")
        return 0

    text = json.dumps(doc, indent=2) + "\n"
    try:
        json.loads(text)                  # never write unparsable JSON
    except json.JSONDecodeError as e:
        print(f"refusing to write malformed JSON: {e}", file=sys.stderr)
        return 2
    MODELS_JSON.write_text(text)
    print(f"\nwrote {MODELS_JSON.relative_to(REPO)}")
    if a.deploy:
        shutil.copy2(MODELS_JSON, LIVE)
        print(f"deployed to {LIVE}")
    else:
        print("review with: git diff config/models.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
