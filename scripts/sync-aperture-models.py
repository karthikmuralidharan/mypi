#!/usr/bin/env python3
"""Regenerate the aperture provider model lists in config/models.json.

The gateway publishes its catalogue at GET /v1/models with context windows,
max output tokens and per-token pricing. Hand-maintaining that drifted: an
audit on 2026-10-14 found 18 models the gateway served that models.json did
not list, including a cheaper Opus 5.5 and a 1M-context Haiku 5.5.

Design notes, learned the hard way:

* Provider-level fields (baseUrl, apiKey, api) are never touched. Only each
  provider's `models` array is regenerated.
* Existing per-model entries are MERGED, not replaced. The gateway does not
  publish `input` or `reasoning`, so hand-set values survive and only
  contextWindow, maxTokens, name and cost are refreshed from upstream.
* A provider is only written if it ends up with at least one model. An empty
  models array makes every `enabledModels` pattern match nothing, which leaves
  pi with no usable model at all.
* `promptCache` is deliberately NOT emitted. Declaring it enables cache
  warming, which is a separate decision that was explicitly reverted.
* Models are assigned to a provider by their advertised `supported_endpoints`,
  not by guessing from the id. A model declared under the wrong api registers
  fine and then fails at request time.

Usage:
  scripts/sync-aperture-models.py            # update config/models.json
  scripts/sync-aperture-models.py --check    # exit 1 if out of date (no write)
  scripts/sync-aperture-models.py --deploy   # also copy to ~/.pi/agent
"""
import argparse
import json
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

# provider name -> predicate over the gateway's supported_endpoints
ROUTES = {
    "aperture-bedrock": lambda eps: any(e.startswith("/bedrock/") for e in eps),
    "aperture-completions": lambda eps: "/v1/chat/completions" in eps,
    "aperture-responses": lambda eps: "/v1/responses" in eps,
}
# Served by the gateway but with no provider block to put them in. Reported,
# never written: they speak Anthropic Messages, so they need their own
# provider with api "anthropic-messages".
UNROUTED = "/v1/messages"


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


def build_entry(gw, existing):
    """Gateway fields overlay an existing entry; hand-set fields survive.

    Only fields the gateway actually publishes are written. `input` and
    `reasoning` are never invented: the existing gpt-* entries omit both and
    work, so defaulting them here would assert image support and extended
    thinking that upstream never claimed.
    """
    out = OrderedDict(existing) if existing else OrderedDict()
    out["id"] = gw["id"]
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
    return out


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
    src = providers.get("aperture-completions")
    if not src:
        print("no aperture-completions provider to read the catalogue from",
              file=sys.stderr)
        return 2

    catalogue = fetch(src["baseUrl"], src["apiKey"])
    by_id = {}
    for m in catalogue:
        by_id.setdefault(m["id"], m)   # gateway lists some ids twice
    print(f"gateway: {len(catalogue)} records, {len(by_id)} distinct ids")

    added, updated, unrouted = {}, {}, []
    for name, matches in ROUTES.items():
        prov = providers.get(name)
        if prov is None:
            continue
        have = OrderedDict((m["id"], m) for m in prov.get("models") or [])
        rebuilt, new_ids, changed = [], [], []
        for mid, gw in sorted(by_id.items()):
            if not matches(gw.get("supported_endpoints") or []):
                continue
            entry = build_entry(gw, have.get(mid))
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
            continue
        prov["models"] = rebuilt
        if new_ids:
            added[name] = new_ids
        if changed:
            updated[name] = changed

    for mid, gw in sorted(by_id.items()):
        eps = gw.get("supported_endpoints") or []
        if UNROUTED in eps and not any(f(eps) for f in ROUTES.values()):
            unrouted.append(mid)

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

    if unrouted:
        print(f"\n=== served but not configurable here ({len(unrouted)}) ===")
        print("  These speak Anthropic Messages and need their own provider")
        print('  block with api "anthropic-messages":')
        for i in unrouted:
            print(f"    {i}")

    if a.check:
        drift = bool(added or updated)
        print(f"\n--check: {'DRIFT' if drift else 'up to date'}")
        return 1 if drift else 0

    if not (added or updated):
        print("\nnothing to write")
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
