# Cohesion: why this setup needed a referee

Record of the oh-my-pi (OMP) comparison and the decisions it produced. The
resulting routing table and precedence ladder live in `config/AGENTS.md`, inside
`<!-- BEGIN MYPI REFEREE -->` markers.

## The problem, measured

This setup runs 26 pi extensions. Each was authored independently and each
recommends its own tools in its own guidance text. Verified collisions:

| Finding | Evidence |
| --- | --- |
| context-mode loaded twice | `pi-mcp-adapter` reads `<agent dir>/mcp.json`, the same file pi's native MCP loader reads. Both register the server: 11 tools appear as `ctx_*` **and** as `context-mode_ctx_*`. 22 schemas, 11 jobs. |
| Phantom dependency | `pi-subagents` was in `npm/package.json` but not in `settings.json` `packages[]`, with zero dependents. **Correction to an earlier claim:** it was *not* actually loaded — its `structured_output` tool never appears in the live tool list, confirming pi loads from `packages[]`, not from `node_modules` presence. So this was dependency-graph noise, not token cost. Removed for hygiene; no capability or token change. |
| 8 extensions on `tool_result` | context-mode, pi-cmux, pi-herdr-subagents, pi-hermes-memory, pi-lens, pi-mcp-adapter, pi-rtk-optimizer, pi-subagents — a load-order-dependent middleware chain. **Now 7:** `pi-herdr-subagents` was retired in the delegation consolidation. |
| 11 extensions on `before_agent_start` | **Corrected, verified against `core/extensions/runner.js`'s `emitBeforeAgentStart`:** this is a sequential fold, not an overwrite — each handler receives the *previous* handler's already-modified `systemPrompt`, and only a handler that returns `{systemPrompt: ...}` advances it for the next one. Of the 11, only 2 unconditionally mutate it today (`pi-hermes-memory`, `pi-karpathy-guidelines`), both additive (`event.systemPrompt + extra`), plus 2 more that are conditional and currently inactive (`pi-rtk-optimizer`'s troubleshooting note, `pi-autoresearch`'s mode banner). `context-mode` deliberately does **not** touch `systemPrompt` at all — its own comment says mutating it would break prefix prompt-caching, so it injects its routing/memory context as a trailing message via the separate `context` hook instead. Net effect: load order controls *where in the sequence* each block lands, not who "wins" — nothing is silently dropped. |
| 3–4 delegation systems | `Agent` · `subagent` (herdr) · `workflow` (dynamic-workflows) · `@tintinweb/pi-subagents` · orphaned `pi-subagents`. **Resolved:** now exactly one, `pi-subagents` (nicobailon). See "Delegation consolidated" below. |
| 5 contradictory search directives | context-mode says prefer `ctx_execute` over bash; pi's core guidelines say use bash for `ls`/`rg`/`find`; pi-lens says prefer ast-grep over text search; pi-fff says prefer `ffgrep` over `ls`/`find`/`bash`. |

The last row is the real cost. For *"find where X is defined"* there were five
sanctioned, mutually-contradictory paths and no arbiter, so tool choice was
effectively arbitrary per session. That non-determinism is what "incohesive"
actually meant.

## Are OMP's tools better?

Axis-by-axis, judged by reading both systems (design judgment, not benchmarks):

| Axis | OMP | Here | Winner |
| --- | --- | --- | --- |
| Text search | `pi-walker` + fail-open regex, shared scan cache | `ffgrep` (frecency-ranked, git-aware) | Tie |
| Code intelligence | `pi-ast` summary + BFS unfold-to-budget | pi-lens: `symbol_search`, `module_report`, `read_symbol`, blast radius, LSP | **Here** |
| File reading | summarized by default, per-agent verbatim override | pieces present, no default policy | OMP (policy) |
| Bash | `pi-shell`: minimizer, interceptor, env hardening, auto-background | `bash` + two uncoordinated compactors | **OMP, decisively** |
| Memory | mnemosyne: automatic background extraction → generated `SKILL.md` | hermes: categorized failures, `skill_manage`, `session_search` | Tools here; **automation OMP** |
| Delegation | one `task` system + role aliases (`@review`, `@smol`) | 3–4 overlapping systems | **OMP, decisively** |
| Rules | TTSR + explicit precedence ladder, first-wins, dedup vs system prompt | unarbitrated | **OMP, decisively** |
| Web/docs | not a focus | rpiv-web-tools (9 providers), context7 | **Here** |
| Advisor | watchdog: proactive push, emission guard, `immuneTurns` | rpiv-advisor: pull, fires only when asked | OMP (in kind) |
| Compaction | shake + cache-aware pruning | context-mode + pi-rtk-optimizer | OMP (principle) |

**Conclusion: mostly no.** OMP wins about six of ten axes, but on four of those the
win is a *mechanism*, not a tool — and pi-lens genuinely beats `pi-ast` on code
intelligence.

OMP feels cohesive because one author made one decision per axis and then encoded
an explicit priority ladder: `native 100 → omp-plugins 90 → agents 70 → cursor 50
→ cline 40 → github 30 → builtin 1`, first-wins dedup by name, with always-apply
rules deduped against the system prompt so nothing is injected twice. That ladder
is the transferable artifact — more than any individual tool.

## Decisions encoded in the referee

One tool per job, chosen on these grounds:

- **`fffind` / `ffgrep` for lookup.** Frecency ranking suits a human working set
  better than OMP's mtime ordering. Beats raw `bash rg` on ranking and beats
  built-in `grep`/`find` on git-awareness.
- **pi-lens for comprehension.** `module_report` → `read_symbol` is the axis where
  this setup is strictly ahead of OMP; the referee makes it the default path
  instead of one option among five.
- **`ast_grep_search` only when genuinely structural.** It was competing with
  `ffgrep` for text queries it is worse at.
- **`ctx_execute` gated on output size, not on preference.** Its own guidance
  claims priority over bash generally; the referee narrows it to large or
  unknown-size output, which is where it actually wins.
- **`memory_search` vs `ctx_search` split by durability.** Cross-session memory
  vs content indexed earlier in the same session — these were being used
  interchangeably.
- **One delegation system: `subagent`, from `pi-subagents` (nicobailon).** Chosen
  for breadth, then narrowed to a single package once the evidence supported it.

  This bullet previously named `Agent` and, in trying to be careful, said the three
  installed systems were "not redundant" and must all be kept. Both framings were
  wrong in opposite directions, and the sequence is instructive. First I proposed
  retiring `@tintinweb/pi-subagents` without checking what it registered — it
  registers `Agent`, so that would have deleted delegation outright. Overcorrecting,
  I then argued the three were three irreducible execution models. Reading
  nicobailon's docs showed that was also overstated: it provides `agent`,
  `subagent`, `subagent_wait`, scripted parallel and chain runs via
  `runs.run`/`runs.all`, and terminal-tab observation of children. One package covers
  all three surfaces, and the compound skills' Pi guidance named it all along.

  The transferable lesson is narrower than either position: **verify which package
  registers a tool before reasoning about whether it is redundant.** Grep the live
  tool description back to its package. Neither the package name nor a plausible
  story about "execution models" is evidence.

## Web tooling consolidated

Started as three overlapping tools, ended as two with no overlap.

`rpiv-web-tools` was removed. Its `web_search` needed a provider API key that was
never configured, so it could not return results at all — and a dead tool that
looks usable is worse than no tool, since it silently absorbs routing decisions.
Its `web_fetch` worked but returned raw pages including navigation chrome: 21KB
to answer a question that a shaped call answered in 226 bytes.

Replaced by one extension owning both jobs, `extensions/websearch/`:

| Job | Tool |
| --- | --- |
| A question | `web_research` — OpenAI's built-in web_search via the aperture gateway; returns a synthesized answer plus cited URLs |
| A URL you hold | `web_fetch` — chrome stripped, entities decoded, length capped with an explicit truncation note |
| Large or many pages | `ctx_fetch_and_index` then `ctx_search` — the page never lands in context whole |

Measured: `web_research` 10,222-byte payload → 226 bytes returned (97.8%);
`web_fetch` 145,410 HTML chars → 10,071 (93.1%).

No OAuth was needed and none was added. pi's ChatGPT Plus/Pro OAuth grants Codex
*models*, not a search tool, whereas the gateway already exposes `/v1/responses`
with `web_search` and needs no credential on the tailnet.

### Retired: the `web-search-researcher` agent

Deleted from `~/.pi/agent/agents/` (64 → 63) with its `.rpiv-managed.json` entry
removed. Recorded here because `agents/` is plugin-generated and therefore not
versioned, so the reasoning has no other home.

It shipped *with* `rpiv-web-tools` and referenced `ext:rpiv-web-tools/web_search`,
so removing that package left it pointing at tools that no longer exist. Three
facts made deletion the right call over repair:

1. **Nothing dispatched it.** No skill referenced it by name — only the file
   itself and the manifest.
2. **Its job is now one tool call.** The agent existed to keep a large
   search-then-fetch cycle out of the main context; `web_research` returns a cited
   answer directly, so the subagent hop bought nothing.
3. **Its owning package is gone**, so no plugin will recreate it. Deletion is
   durable rather than drift.

A copy is kept under `~/mypi-memory-backup-*/retired-agents/`. If a web-research
subagent is ever wanted again, write it against `web_research` with bare tool
names — not `ext:` references, which are resolver-specific and would not survive
a change of subagent implementation.

Escalation is explicit: cheapest tool first, escalate only on actual failure. Two
tools on one job means the first failed and that should be stated.

## Open items

Not yet done, deliberately:

1. **context-mode double registration.** Removing the `mcp.json` entry is the
   likely fix (the npm extension already provides the hooks), but confirming which
   loader owns the bare `ctx_*` names needs a restart-and-observe test. Not run
   mid-session while those tools were in use.
2. **Two compactors.** context-mode and pi-rtk-optimizer both hook `tool_result`.
   That they *conflict* is inferred from co-registration, **not proven** — no
   evidence yet that output is compacted twice. Verify before removing either.
3. ~~**Delegation cleanup.**~~ **Done** — `@tintinweb/pi-subagents`,
   `pi-herdr-subagents` and `@quintinshaw/pi-dynamic-workflows` were retired in
   favour of `pi-subagents` (nicobailon). Packages 23 → 21. Compatibility was
   audited first: all 63 agents use only `name`/`description`/`tools`/`isolated`,
   none reference removed tools, and User-scope discovery reads them unchanged.
   Costs are recorded in `config/AGENTS.md` under "Delegation systems".
4. ~~`pi-subagents` orphan removal.~~ **Done** — removed from `package.json`. Note it was a phantom dependency, never loaded, so this bought hygiene rather than tokens.

5. **Does the referee actually change behavior?** It is installed but unproven. The
   honest test is subjective over the next few sessions: does tool choice for
   "find where X is defined" become consistent? If contradictory extension guidance
   at priority 60 still wins in practice, the ladder needs to move from `AGENTS.md`
   into an enforcing `tool_call` hook — prose losing to code, exactly the lesson
   from OMP's `emission-guard.ts:14`.

## Model routing: retired the standing Aperture extension, split into two paths

Removed `@aliou/pi-ts-aperture` (packages 21 → 20) and `config/extensions/
aperture.json`, the only way `pi` reached a model, with no way to switch
backend/provider without hand-editing that file and restarting.

The gateway (`ai-gateway.tail692491.ts.net`) turned out to serve its two model
families through genuinely incompatible protocol shapes, so replacing it took
two different mechanisms rather than one:

- **Claude/Anthropic — native, no extension.** `defaultProvider` is
  `amazon-bedrock` again. pi's built-in provider is the bundled
  `@aws-sdk/client-bedrock-runtime`, which honors the standard AWS SDK
  endpoint-override env var (not pi-specific) — `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`,
  set in `config/fish/pi-bedrock-gateway.fish` to the gateway's `/bedrock`
  path. **Correction to an earlier claim in this section:** it was first
  recorded here as "does not work as a substitute," tested only *without* the
  endpoint override, which does hit real AWS with the wrong credentials and
  fails exactly as originally reported (`UnrecognizedClientException`). With
  the override set, the same command returns a real response — verified live,
  including a second confirmation from a real `fish` shell with no manual
  exports, so it's not an artifact of a hand-set env var in one test shell.
  No skip-auth flag needed, unlike Claude Code's equivalent
  `CLAUDE_CODE_SKIP_BEDROCK_AUTH` — whatever credentials the AWS SDK's default
  chain finds locally are sufficient to sign a request the gateway accepts.
- **OpenAI — [`aperture-cli`](https://github.com/tailscale/aperture-cli)
  launcher.** (`tailscale/aperture-cli#26` added Pi support.) The gateway
  serves OpenAI models over `/v1/responses`/`/v1/chat/completions`, which pi
  has no built-in provider for. `aperture` is a separate binary, run instead
  of `pi` directly: it presents a provider/backend/model menu, writes a
  *temporary* per-launch extension registering the chosen route under a
  namespaced provider ID (`aperture-<providerID>`, never colliding with a
  built-in), execs `pi -e <tmpfile> --model ...`, and deletes the extension on
  exit — `~/.pi/agent/` (settings, auth, sessions) is never touched. Its Pi
  client only recognizes OpenAI Responses, Anthropic Messages, OpenAI Chat,
  and Google Vertex — Bedrock is excluded on purpose ("loads from a provider
  definition but fails at request time against Aperture"), which is exactly
  why Claude needed the native path above instead of also going through here.

Verified before finalizing either path:

- **Subagent delegation is unaffected either way.** `pi-subagents` runs
  children in-process (grepped its source for a `pi` binary spawn — none), so
  whichever provider the top-level session resolves (native bedrock, or one
  injected by `aperture`) is inherited by every in-process subagent
  automatically. Nothing shells out to a second `pi` process that would need
  its own routing.

`aperture` is `go install`ed to `~/go/bin` (not Homebrew — no formula exists),
so `config/fish/go-bin-path.fish` puts that directory on `PATH`.

## What was deliberately not ported

Per the evaluation, adding more OMP mechanisms to an unrefereed system makes
cohesion worse. Deferred until the referee proves itself: mnemosyne-style
automatic memory extraction, TTSR, and the advisor watchdog — each has an adequate
substitute here. The two worth building later are the **bash interceptor + env
hardening** (weakest axis here, strongest there, ~100 lines) and the ladder
itself, now encoded.

See `OMP-PORT-PLAN.md` for the full feature-level research with source references.
