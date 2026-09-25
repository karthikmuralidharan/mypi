# Changelog

This file records the changes made to this pi setup that are big enough to
need an explanation — what was wrong, what changed, and why. It exists so the
reasoning isn't lost or re-argued later. Small changes don't need an entry
here; this is for decisions, not every edit.

The routing rules these entries produced live in `config/AGENTS.md`, inside
the `<!-- BEGIN MYPI REFEREE -->` block.

## Memory moved from pi-hermes-memory to mnemosyne

pi-hermes-memory was doing two jobs with very different weights: it kept a
small set of hand-curated markdown memory files (global, user profile,
failure lessons, per-project), and it archived every session transcript into
a 1.7 GB `sessions.db` with its own LLM-driven review pipeline
(`llmModelOverride`, child extensions, a config file that had to re-root
absolute paths on every machine). The curated memory is the valuable part;
the review machinery was the fragile part — better-sqlite3 ABI breaks after
Node updates, a config file outside pi's own settings, and an extra model
routing path to keep pointed at the gateway.

mnemosyne (mnemosyne-oss/pi-mnemosyne) covers the valuable part with none of
the machinery: local-first SQLite, zero config, a pure CLI (`mnemosyne
store/recall/delete/stats/sleep`) that the pi extension proxies as
`mnemosyne_remember` / `mnemosyne_recall` / `mnemosyne_forget` /
`mnemosyne_stats` / `mnemosyne_sleep`. The CLI installs with
`uv tool install mnemosyne-memory`; the DB lives at
`~/.hermes/mnemosyne/data/mnemosyne.db`.

Migration: all 145 curated entries moved over with a one-off script that
split the hermes markdown files on their `§` separators, stripped the
`<!-- created=…, last=… -->` metadata comments (mnemosyne tracks its own
timestamps), and called `mnemosyne store` per entry. Provenance is preserved
in the source tag: `hermes:global`, `hermes:user`, `hermes:failures`,
`hermes:project:<name>`. Verified by recall probes (LSP routing policy and
the JIRA Team-field convention both surface as top hits). `sessions.db` was
deliberately not migrated — it is a raw transcript archive, not curated
memory, and mnemosyne has no equivalent surface; the hermes directories stay
on disk as an archive, untouched. Hermes's learned-skills directories
(`pi-hermes-memory/skills`, `projects-memory/*/skills`) are likewise
archived; mnemosyne has no skill concept.

Referee rows in `config/AGENTS.md` now route recall to `mnemosyne_recall`
(there is no `session_search` replacement) and durable writes to
`mnemosyne_remember`. `hermes-memory-config.json` is gone from the repo, the
live dir, `sync.sh`, and `bootstrap.sh` (including the childExtensionPaths
re-rooting block).

## Aperture routing moved into pi's own models.json

The Aperture gateway used to need three separate pieces of plumbing:
`config/fish/aperture-gateway.fish` exported `$APERTURE_GATEWAY_HOST` and
pointed pi's built-in `amazon-bedrock` provider at the gateway via
`AWS_ENDPOINT_URL_BEDROCK_RUNTIME`; OpenAI models went through the separate
`aperture` launcher binary, which injected a temporary per-launch extension;
and `web_research` read the env var as its fallback endpoint. Three
mechanisms for one gateway, two of them outside pi's own config.

The gateway now publishes a ready-made `models.json` — pi's native
custom-provider file. That one file replaces all of the plumbing: the fish
file, the launcher, the retired `@aliou/pi-ts-aperture` dependency, and
the `aperture.json` sync path are gone. `web_research` no longer keeps any
endpoint of its own: its config is a `provider/model-id` reference
(default `aperture-responses/gpt-5.6-luna`) that it resolves through pi's
model registry — endpoint and credentials come from the provider that owns
the model — so the gateway host still lives in exactly one place.

The published config did not match what this gateway actually routes, so
the Claude side deviates from it. Probing `GET /v1/models` and each
protocol endpoint showed: Claude models exist only with `us.anthropic.*`
IDs and are served only through bedrock endpoints
(`/bedrock/model/{model}/converse-stream`) — `/v1/messages` 404s for every
Claude ID, prefixed or not. So Claude goes through an `aperture-bedrock`
provider with `api: "bedrock-converse-stream"` (pi honors the provider
`baseUrl` as the client endpoint, and `AWS_BEDROCK_SKIP_AUTH=1` from
`config/fish/config.fish` skips signing), not the published
anthropic-messages provider. The published `openai.*`/`us.openai.*` GPT
aliases also 404; only the bare catalog IDs (`gpt-5.5`, `gpt-5.6-luna`,
…) route, so those are the IDs in the file. `defaultProvider` is
`aperture-bedrock`, default model `us.anthropic.claude-sonnet-5`, and the
hermes-memory `llmModelOverride` points at the same provider now that the
bedrock endpoint env override is gone.

## Too many extensions were giving contradictory advice

This setup runs about 20 pi extensions. Each one was written separately, and
each recommends its own tools in its own instructions. That produced real
conflicts:

- **A tool loaded twice.** `pi-mcp-adapter` and pi's own MCP loader both read
  the same config file and both registered the same server — so 11 tools
  showed up twice, once as `ctx_*` and once as `context-mode_ctx_*`.
- **Five different, contradictory answers to "how do I search for something."**
  One extension said use `ctx_execute`, pi's own instructions said use `bash`,
  another said prefer `ast-grep`, another said prefer its own `ffgrep`. With no
  tie-breaker, which tool got used was basically random from one session to
  the next.
- **Three or four separate systems for delegating work to a sub-agent**,
  overlapping in what they did.

The fix was a routing table in `config/AGENTS.md`: one job, one designated
tool, so there's no more picking between five options that disagree with each
other. See the entries below for how the individual conflicts were resolved.

### Comparing against oh-my-pi (OMP)

Before writing that routing table, this setup was compared feature-by-feature
against oh-my-pi, a different reference pi configuration, to see if it did
things better. Conclusion: not really — OMP wins on about six of ten
dimensions, but four of those wins are because OMP enforces *one* choice per
job with a clear priority order, not because its individual tools are
better. This setup's own code-navigation tool (`pi-lens`) is actually ahead of
OMP's equivalent. The main thing worth borrowing from OMP wasn't a tool, it
was the idea of an explicit, numbered priority order for whose instructions
win when two disagree — that's what `config/AGENTS.md`'s priority list now
does.

Two things were deliberately **not** copied from OMP, to avoid adding more
untested complexity on top of an already-crowded setup: automatic background
memory extraction, and a proactive "watchdog" that interrupts the agent
unprompted. Revisit these if the routing table proves itself over time.

## Delegation was consolidated into one system

There used to be three or four different ways to hand off work to a
sub-agent, installed by different packages, overlapping in confusing ways.
This got fixed in two passes, and the story of the second pass is worth
recording because it shows a mistake worth avoiding:

1. First pass: removed a package without checking what it actually provided
   — it happened to be the one that registered the main delegation tool,
   so that removal would have deleted delegation outright. Caught before it
   shipped.
2. Overcorrecting from that scare, the next draft argued all three systems
   were irreducible and had to stay. That was also wrong — reading the
   surviving package's own documentation showed it already covered
   everything the other two did.

Now there is exactly one delegation system, provided by the `pi-subagents`
package. The lesson that generalizes: **before deciding whether something is
redundant, check which package actually provides the tool in question.**
Don't reason from the package's name or a plausible-sounding story about what
it "must" be for.

## Two smaller cleanups

- **A phantom dependency.** One package was listed as a dependency but never
  actually loaded (verified: its tool never showed up in the live tool list).
  Removed for tidiness — it wasn't costing anything, so this was hygiene, not
  a fix.
- **Web search/fetch tools, consolidated.** There were three overlapping web
  tools. One needed an API key that was never configured, so it silently
  didn't work at all — worse than not having it, since it could still get
  picked and then fail. Replaced all three with one extension that does both
  jobs (a question → search + cited answer; a URL you already have → fetch
  and strip the page down). Measured savings: a 10KB search payload became
  226 bytes; a 145KB fetched page became 10KB.

## A wrong assumption about how instructions get combined, corrected

Multiple extensions add their own text to the instructions pi sends the
model on every turn (things like "always follow this coding style"). It was
assumed that when two extensions do this, the second one's text *replaces*
the first's — i.e. whichever extension loads last wins, and earlier
extensions' instructions get silently dropped.

That assumption was wrong, and it got checked against pi's actual source
code: each extension actually sees and adds onto whatever the previous one
already wrote, cumulatively. Nothing gets silently dropped. Load order only
decides where in the combined instructions each piece ends up, not whether it
survives at all.

Of the roughly 10 extensions that get a chance to add to those instructions,
only two currently do so unconditionally (the memory tool, and a coding-style
guideline). A couple of others do it only in specific modes that aren't
normally on. One extension deliberately does *not* add to these instructions
at all, even though it easily could — doing so would break response caching,
so it appends its own reminder as a separate message instead, later in the
conversation.

## Model access was split into two separate paths

There used to be one extension that was the *only* way pi could reach any
AI model at all. Changing which model or provider it used meant hand-editing
its config file and restarting. That extension has been removed.

The AI gateway this setup talks to turned out to serve its two model
families — Claude and OpenAI — in two genuinely different, incompatible ways.
So replacing the one old extension took two different fixes, not one:

- **Claude models now work without any extension at all.** pi has this
  built in already; it just needed to be pointed at the internal gateway
  instead of the real Anthropic/AWS service. That's one environment variable
  (`AWS_ENDPOINT_URL_BEDROCK_RUNTIME`), set automatically by
  `config/fish/aperture-gateway.fish`. Confirmed working with real
  requests, more than once, including from a brand-new terminal with nothing
  manually configured.

  (Earlier notes here claimed this didn't work at all — that was wrong. That
  first test never set the environment variable above, so of course it
  failed. Once it's set, it works.)

- **OpenAI models go through a separate launcher tool, `aperture`, instead
  of running `pi` directly.** pi has no equivalent built-in support for how
  this gateway serves OpenAI models. `aperture` is a different program you
  run instead of `pi`; it shows a menu, then starts `pi` itself with a
  temporary, one-time config for whichever model you picked, and cleans that
  config up when you quit. Your normal pi settings are never touched by it.

  **This path is currently broken**, and it's a real bug, not a setup
  mistake here: `aperture` sends a placeholder credential that this gateway
  actively rejects (confirmed by testing the raw request directly, outside of
  pi entirely — the gateway works fine with *no* credential sent, but rejects
  any fake one). Reported to the team that runs the gateway; not yet fixed
  upstream.

One thing worth knowing: whichever of the two paths you start pi with, any
sub-task pi delegates to a helper agent automatically uses that same model
access — confirmed by checking that delegation runs inside the same running
program rather than starting a whole new `pi` process that would need its
own setup.

### The web-search tool broke silently, from the same removal

`web_research` (the tool that answers a question by searching the live web)
had its own copy of "where's the gateway" logic: read its own optional config
file first, and if that didn't set anything, fall back to reading the old
Aperture extension's config file. Once that extension and its config file
were gone, the fallback had nothing left to read, and the tool started
failing outright — this went unnoticed until it was actually used again.

Rather than patch that one broken fallback, the read-the-other-extension's-
config approach was retired for a shared environment variable instead —
the same one below now sets. `config/fish/aperture-gateway.fish` is now the
one place the gateway's hostname lives at all: it exports
`$APERTURE_GATEWAY_HOST`, and both pi's built-in Claude access and
`web_research` read from that instead of each keeping an independent copy
that could drift the next time the gateway moves. (This file used to be
named `pi-bedrock-gateway.fish`, back when it only had one reader.)

## Open questions, not yet resolved

- Is the duplicate tool registration (mentioned above) actually causing
  problems, or just visual clutter? Needs a restart-and-observe check.
- Two different extensions both intercept and shrink command output before
  it reaches the model. They *might* be shrinking the same output twice, but
  that's a guess from noticing both are active — nobody has actually caught
  it happening.
- Does the routing table in `config/AGENTS.md` actually change which tool
  gets picked in practice? It's in place, but hasn't been checked over enough
  real sessions to be sure it's working rather than being ignored.
