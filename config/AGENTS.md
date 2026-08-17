<!-- BEGIN COMPOUND PI TOOL MAP -->
## Compound Engineering (Pi compatibility)

This block is managed by compound-plugin.

Pi extensions used by this plugin:
- Required: `pi-subagents` (by nicobailon) provides the `subagent` tool used by skills that dispatch parallel agents
- Recommended: `pi-ask-user` (by edlsh) provides the `ask_user` tool; skills fall back to numbered options in chat when it is missing

Install with:
  pi install npm:pi-subagents
  pi install npm:pi-ask-user
<!-- END COMPOUND PI TOOL MAP -->

<!-- BEGIN MYPI REFEREE — hand-authored, see mypi/docs/COHESION.md -->
## Tool routing

This setup has ~26 extensions that each recommend their own tool. Several
recommendations contradict each other. This table is the tiebreaker: it wins over
any tool's own self-description. Pick from it and move on — do not deliberate
between equivalent tools, and do not try a second tool on the same job unless the
first actually failed.

| Job | Use | Not |
| --- | --- | --- |
| Find files by name, path, or concept | `fffind` | `ls`, `find`, `bash find` |
| Find text, or a symbol in an unindexed language | `ffgrep` | `grep`, `bash rg`, `bash grep` |
| **Find where a symbol is defined or used** | `lsp_navigation` definition / references / implementation | `ffgrep` for a symbol the LSP knows |
| **Trace who calls what** | `lsp_navigation` call hierarchy | grepping for the function name |
| **Rename a symbol or move a file** | `lsp_navigation` `rename` / `rename_file` with `apply` | hand-editing each call site |
| Orient in an unfamiliar project | `project_report` | walking the tree by hand |
| Understand an unfamiliar file | `module_report`, then `read_symbol` | reading the whole file |
| Read a known region | `read` with offset/limit | `cat`, `head`, `sed -n` |
| Match a code pattern structurally | `ast_grep_search` | regex over source |
| Errors, types, lint | `lens_diagnostics` (see cadence below) | running a build to discover type errors |
| Recall earlier work or decisions | `memory_search`, then `session_search` | re-deriving from scratch |
| Library or API documentation | `query-docs` (context7) | `web_search` for API details |
| A question needing the live web | `web_research` | `web_search` (no provider key — non-functional) |
| A specific URL you already have | `web_fetch`, or `ctx_fetch_and_index` when the page is large | `web_research` for a known URL |
| Output whose size is unknown or large | `ctx_execute` | letting it land in context |
| Run a command with short known output | `bash` | `ctx_execute` |
| Delegate parallel work | `Agent` | mixing delegation systems in one task |

**Prefer the LSP for navigation, comprehension, and mechanical refactors.** It
answers from a type-aware graph, so `references` finds actual usages while a grep
finds every string that merely looks like one — including comments, unrelated
same-named members, and none of the aliased imports. `rename` with `apply` edits
every real call site atomically and re-syncs the servers afterwards, which
hand-editing does not. Use `ffgrep` when the LSP cannot help: an unsupported
language, config and markup files, log output, or a plain text search.

`lsp_navigation` and the `ast_grep_*` tools are situational and inactive by
default. Activate them **once per session** with `pi_lens_activate_tools`, not
repeatedly.

## Diagnostics cadence

Diagnostic output is verbose and mostly repeats what the previous run said, so
running it after every edit is the single easiest way to waste a context window.
Batch it instead.

| When | Call | Cost |
| --- | --- | --- |
| After a batch of related edits | `lens_diagnostics mode=delta` | cheap — cache read, this turn only |
| Before saying work is done, or before a commit | `lens_diagnostics mode=all` | cheap — cache read, every file edited this session |
| Auditing an untouched codebase | `lens_diagnostics mode=full` | **expensive** — project-wide scan; rare and deliberate only |
| One specific file, right now | `lsp_diagnostics path=<file>` | moderate |

Rules:

- **Do not run diagnostics after every single edit.** Finish a coherent group of
  changes first, then check once.
- pi-lens already runs its own post-write pipeline and surfaces blocking errors
  automatically. A clean turn-end means clean; do not re-verify by polling.
- Never scan a whole directory or use `mode=full` to check a file you just
  touched — `mode=delta` already covers it.
- A build or test run is not a type checker. Reach for diagnostics first; run the
  build to verify behaviour, not to discover type errors.

**Escalation, not enumeration.** Start at the cheapest tool for the job. Escalate
only when it actually returned nothing useful. Two tools on the same job means the
first one failed — say what failed.

**Named contradictions, already resolved.** These extensions disagree in their own
guidance; the table above settles it, and this list exists so the conflict is not
re-litigated every session:

- `ctx_execute` vs `bash` — bash for short, known-size output; `ctx_execute` when
  output is large, unbounded, or needs deriving down to an answer.
- `ffgrep` vs `lsp_navigation` vs `ast_grep_search` vs `bash rg` — `lsp_navigation`
  for symbols the language server understands, `ffgrep` for text and for languages
  or file types it does not, `ast_grep_search` only when the query is genuinely
  structural.
- `read` vs `module_report`/`read_symbol` — outline first for unfamiliar files,
  direct `read` when the target region is already known.
- `memory_search` vs `ctx_search` — `memory_search` for durable cross-session
  memory; `ctx_search` only for content indexed earlier in this session.
- `web_research` vs `web_search` vs `web_fetch` — `web_research` (OpenAI
  web_search via the aperture gateway) returns a synthesized, cited answer and is
  the default for "what is the current X". `web_search` from rpiv-web-tools has no
  provider API key configured and is therefore dead — do not route to it. Use
  `web_fetch` only for a URL you already hold, and be aware it returns the raw
  page including navigation chrome; for anything large prefer
  `ctx_fetch_and_index` and then `ctx_search`.

## Guidance precedence

When instructions conflict, higher number wins. Do not average conflicting
guidance or apply both.

| Priority | Source |
| --- | --- |
| 100 | Explicit user instruction in the current conversation |
| 90 | Project `AGENTS.md` in or above the working directory |
| 80 | This file (global `AGENTS.md`) — including the routing table above |
| 70 | An explicitly invoked skill's instructions |
| 60 | Tool and extension self-description |
| 1 | Model defaults |

A tool's own description is priority 60. It loses to this file. When a tool's
description tells you to prefer it over something the routing table assigns
elsewhere, the routing table wins.
<!-- END MYPI REFEREE -->
