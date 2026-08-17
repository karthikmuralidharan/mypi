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
| 8 extensions on `tool_result` | context-mode, pi-cmux, pi-herdr-subagents, pi-hermes-memory, pi-lens, pi-mcp-adapter, pi-rtk-optimizer, pi-subagents — a load-order-dependent middleware chain. |
| 11 extensions on `before_agent_start` | All chaining `systemPrompt`. Last writer wins by load order. |
| 3–4 delegation systems | `Agent` · `subagent` (herdr) · `workflow` (dynamic-workflows) · `@tintinweb/pi-subagents` · orphaned `pi-subagents`. |
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
- **`Agent` as the single delegation system.** Chosen for breadth (background
  execution, steering, worktree isolation, model override). Not a quality verdict
  on the others; picking *one* is the point.

  This is a routing rule about which tool to *reach for*, not a licence to
  uninstall the others — a distinction this bullet originally failed to make, and
  which nearly caused real damage. Acting on it, the plan was to retire
  `@tintinweb/pi-subagents`; grepping the live tool descriptions to their packages
  showed that package is precisely what registers `Agent`. Removing it would have
  deleted the designated delegation system along with dispatch for 30 agent
  definitions and 13 skills. See "Delegation systems — verified tool ownership" in
  `config/AGENTS.md` for the verified mapping. Confirm which package owns a tool
  before removing anything that sounds redundant.

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
3. **Delegation cleanup.** The referee names `Agent`, but the redundant systems
   are still installed and still contributing tool schemas. Removal is a separate
   change requiring confirmation of what each is used for.
4. ~~`pi-subagents` orphan removal.~~ **Done** — removed from `package.json`. Note it was a phantom dependency, never loaded, so this bought hygiene rather than tokens.

5. **Does the referee actually change behavior?** It is installed but unproven. The
   honest test is subjective over the next few sessions: does tool choice for
   "find where X is defined" become consistent? If contradictory extension guidance
   at priority 60 still wins in practice, the ladder needs to move from `AGENTS.md`
   into an enforcing `tool_call` hook — prose losing to code, exactly the lesson
   from OMP's `emission-guard.ts:14`.

## What was deliberately not ported

Per the evaluation, adding more OMP mechanisms to an unrefereed system makes
cohesion worse. Deferred until the referee proves itself: mnemosyne-style
automatic memory extraction, TTSR, and the advisor watchdog — each has an adequate
substitute here. The two worth building later are the **bash interceptor + env
hardening** (weakest axis here, strongest there, ~100 lines) and the ladder
itself, now encoded.

See `OMP-PORT-PLAN.md` for the full feature-level research with source references.
