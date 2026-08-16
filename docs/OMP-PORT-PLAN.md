# Porting oh-my-pi ideas into stock pi

Research notes from `can1357/oh-my-pi` v17.3.5 (commit `37eee71`), captured so the
analysis does not have to be redone. Source refs are `file:line` **in that repo**,
not this one — reclone with `git clone --depth 1 https://github.com/can1357/oh-my-pi`.

oh-my-pi is a superset fork of pi, not a plugin: 166 MB, Rust natives
(`pi-ast`, `pi-shell`, `pi-walker`, `pi-natives`) under a TypeScript agent, 80+
design docs. Anything living below the N-API boundary is fork-only. Everything
below was checked against stock pi 0.78's real `extensions.md`.

## The framing insight

`packages/coding-agent/src/advisor/emission-guard.ts:14` —
*"The fix is to make the rules load-bearing in code instead of prose."*

Almost every feature here is a prose instruction that measurably failed and was
reimplemented as an enforced mechanism. That lesson transfers even if none of
the individual features do.

## Verified stock-pi hook mapping

| Need | Hook | Confirmed behaviour |
| --- | --- | --- |
| Patch/block a tool call | `tool_call` | `event.input` mutable in place; `return {block, reason, terminate}`. Docs show `event.input.command = "source ~/.profile\n"+cmd` as the sanctioned prefix pattern. |
| Rewrite tool output | `tool_result` | Middleware chain; return partial patch `{content, details, isError, usage}`. |
| Prune context | `context` | Fires before each LLM call. `event.messages` is a **deep copy** — filtering is per-request and never rewrites history, so no cache invalidation. |
| Stream matching | `message_update` | Assistant deltas + `event.assistantMessageEvent`. |
| Replace finished message | `message_end` | `return {message}`, must keep same `role`. |
| Inject system prompt | `before_agent_start` | Returns `{systemPrompt}`, chained; sees `event.prompt`. |

**Gaps that cap fidelity:** no `agent.replaceMessages` (cannot discard an aborted
partial assistant message — accept `contextMode: "keep"` semantics), and no custom
URL protocols (no `rule://`, `artifact://` — use custom read tools instead).

## Ranked port list

| # | Feature | Port | Source |
| --- | --- | --- | --- |
| 1 | Bash interceptor | EASY | `docs/bash-tool-runtime.md` |
| 2 | Non-interactive env hardening | EASY | `buildNonInteractiveEnv()` |
| 3 | Output caps + artifact spill | EASY | `docs/bash-tool-runtime.md:195`, `settings.md:501-503` |
| 4 | Unexpected-stop detection | EASY | `session/unexpected-stop-classifier.ts:44-63` |
| 5 | TTSR non-interrupt tier | EASY | `src/export/ttsr.ts`, `src/discovery/builtin-rules/` |
| 6 | Magic keywords | EASY | `src/modes/magic-keyword-boundary.ts:2,5` |
| 7 | Cache-aware pruning | EASY | `packages/agent/src/compaction/pruning.ts` |
| 8 | Shell minimizer (TOML tier) | EASY–MOD | `crates/pi-shell/src/minimizer/defs/` |
| 9 | Advisor / watchdog | MOD | `docs/advisor-watchdog.md`, `advisor/emission-guard.ts` |
| 10 | Sticky `RULES.md` | EASY | `docs/context-files.md` |

### 1. Bash interceptor

Regex-block `cat`/`head`/`grep`/`rg`/`find`/`sed -i`/`echo > file`, redirect to
`read`/`grep`/`edit`. Blocks **only when the replacement tool is registered**.
The real work is the tokenizer: split on unquoted `&& || ; | |& &` + newlines,
retry fragments with leading `NAME=value` stripped, and **exclude fragments
receiving piped stdin** (`... | grep foo` cannot become a path-based call).
Heredocs, command substitution, backticks, malformed quoting produce no extra
fragments. ~60 lines via `tool_call` → `{block: true, reason}`.

### 2. Non-interactive env hardening

~25 defaults layered *under* caller/direnv overrides: `PAGER=cat GIT_PAGER=cat
LESS=FRX`, `GIT_EDITOR=true EDITOR=true VISUAL=true`, `TERM=dumb
GIT_TERMINAL_PROMPT=0 SSH_ASKPASS=/usr/bin/false NO_COLOR=1 CI=true`, plus
npm/pnpm/yarn/pip/cargo/terraform/gh non-interactive flags. Kills pager/editor
hangs and the ANSI tax. Note oh-my-pi deliberately does **not** apply this to
interactive PTY runs (real `TERM=xterm-256color` so TUIs work).

### 3. Output caps

Three orthogonal caps, not one:

- rolling **tail** 50 KB, UTF-8-boundary-safe
- **head** 20 KB with a middle elision marker, so the model sees both preamble
  and failure tail — naive tail-only truncation destroys the preamble
- **per-line** 768 B applied *at write time*, so one 4 MB minified-JS line
  cannot eat the window. Highest ROI 20 lines in the whole codebase.

Raw stream mirrors to an artifact whenever a cap fires; splice
`[raw output: <path>]` into the footer for lossless recovery.

### 4. Unexpected-stop detection

Catches "I'll run the tests now." → *[turn ends]*. Free gate first:
`stopReason === "stop"` && zero `toolCalls` && non-empty text. Then one-word
classification on a tiny model, 4 s timeout, `maxTokens: 16` local / 4096 online
(reasoning models emit a preamble; Anthropic proxies reject
`max_tokens <= thinking.budget_tokens`). On YES inject:

```text
<system-injection>
You said you would continue with a tool call or action but stopped. Continue now.
Attempt #{{retryCount}}/{{maxRetries}}
</system-injection>
```

`UNEXPECTED_STOP_MAX_RETRIES = 3`; counter resets on any non-candidate turn.

### 5. TTSR — Time-Traveling Stream Rules

Rules matching the *in-flight* stream (prose, thinking, or tool arguments),
aborting and retrying with the rule injected. Value: rule bodies cost **zero
tokens until violated**. Rule files are SKILL.md-shaped —
`src/discovery/builtin-rules/ts-no-any.md:1-6`:

```yaml
description: "Never use `any` in TypeScript..."
condition: ": any|as any"
scope: "tool:edit(*.ts), tool:write(*.tsx)"
interruptMode: never
```

`scope` tokens: `text`, `thinking`, `tool`, `tool:<name>(<glob>)`. Default watches
text + all tools but **not** thinking. Matching runs on a *reconstructed digest*
(`new_string` / added patch lines / full `content`), not raw deltas. Anti-nag:
`repeatMode: once` or `after-gap` with `repeatGap: 10` **completed** turns.

**Start with the non-interrupt tier** — every shipped builtin uses
`interruptMode: never`. Via `tool_call` you get something strictly better than
oh-my-pi: block with the rule text as `reason` so the bad write never happens.
Steal the 28 builtin rule bodies directly. Port `condition` only, not
`astCondition` (needs in-process ast-grep).

### 6. Magic keywords

Bare lowercase prose words attach a hidden instruction for that turn only
(`ultrathink` also raises reasoning effort to model max). The boundary regexes
are the entire value — copy verbatim from
`src/modes/magic-keyword-boundary.ts:2,5`:

```js
LEFT_BOUNDARY  = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`
RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`
```

`orchestrate,` matches; `orchestrated`, `orchestrate.ts`, `foo::orchestrate`,
`orchestrate()` do not. Run against a fenced/inline/HTML masker so source code
never misfires it.

### 7. Cache-aware pruning

Blank superseded `read` results before compaction fires. The non-obvious part:
mutating message *i* forces a provider rewrite of everything after it at
cache-write premium, so it only fires when the mutation is cheap
(`pruning.ts:108-109`, `:255-300`):

```text
prune iff  i >= boundaryIndex && suffixTokens[i] <= 8_000   // warm tail
        || now - lastMessageTs >= 30min                      // cache cold
```

- Supersede key is selector-aware with a NUL-separated parent, so a whole-file
  read supersedes range reads of the same file (`pruning.ts:420-427`).
- `MIN_PRUNE_TOKENS = 50` (`:123`) — the `[Output truncated - N tokens]`
  placeholder costs ~8 tokens, so pruning anything smaller *grows* context.
- `protectTokens: 40_000`, `minimumSavings: 20_000`; tool-flagged useless
  results bypass the protect window.
- Protected: `skill` results, `skill://` reads, active plan file.

Stock pi's deep-copied `event.messages` makes this strictly easier than upstream.

### 8. Shell output minimizer

Program-aware output rewriting instead of position-blind truncation. The Rust
filters (`git.rs` 90 KB, `jvm.rs` 122 KB, `docker.rs` 55 KB) are not portable —
but **68 declarative TOML defs in `minimizer/defs/` are data, worth ~80% of the
value**. Schema: `match_command`, `match_subcommand`, `strip_ansi`,
`strip_lines_matching[]`, `keep_lines_matching[]`, `replace_after[]`,
`max_lines`, `truncate_lines_at`, `on_empty`, plus inline `[[tests.X]]` fixtures.

Reusable constants: floor `MIN_MINIMIZE_CHARS = 1_000`; cap classes
`Errors=160 Warnings=120 List=80 Inventory=40` lines; consecutive-line dedup as
`line (×N)`; single-line truncation appending **`…[+N]`** where N = dropped chars
so the agent can tell minimizer ellipsis from real `…`; filter semantics
`keep AND NOT strip`. Filters run under `catch_unwind` and degrade to passthrough.

### 9. Advisor / watchdog

Second model receives transcript **deltas** (including reasoning), investigates
with read-only tools, injects `<advisory>` notes that can steer the live turn.
Advisor messages are stripped before the next delta so it never reviews itself.

The **emission guard** is the part to port, and it exists because of
measurement — `__advisor.jsonl` logged *309 advise calls covering 92 unique
notes: 114× "Stop.", 52× "No issue; continue."* Four stages: NFKC +
`[^\p{L}\p{N}]+`→space normalization; 40-phrase content-free blocklist; session
FIFO-4096 exact dedupe; **1 accepted note per model cycle**. Suppression is
invisible to the advisor — telling it "suppressed" makes it rephrase to evade
dedupe. Plus `immuneTurns: 3` downgrading everything to asides after a
successful interrupt.

Severity state machine (`advisor/advise-tool.ts:118-133`): `nit` → batched
aside; `concern` → steers unless the turn ended in a terminal answer; `blocker`
→ steers regardless. A user Esc sets `autoResumeSuppressed` so it never
resurrects a killed run.

The system prompt is mostly prohibitions (`prompts/advisor/system.md`):

- `:23` `NEVER restate information agent has, including seen errors`
- `:34` `NEVER advise on intent or process`
- `:40` `NEVER police scope or ambition ... often user wants it`
- `:44` `NEVER raise backwards compatibility unless explicitly required`
- `:26` `NEVER nitpick what user accepts`
- `:16` budget: `Per advise: 2–3 tool calls`

Port the guard, not just the prompt. Degrade to aside-or-steer only (the
passive *preserve* channel needs session internals pi does not expose).

### 10. Sticky RULES.md

`AGENTS.md` sits at the top of the transcript and loses salience by turn 100.
`RULES.md` is re-attached **near the current turn**, so hard prohibitions keep
positional weight. Name-based dedup, user shadows project, never concatenated.
Port as a `context` hook appending a short developer message before the last
user turn; keep under ~30 lines.

## Deliberately skipped

- **snapcompact** — renders discarded history to PNG bitmaps with 8×13 pixel
  fonts and feeds them back as images, arbitraging per-family vision billing
  (Gemini bills a flat 1,120 tokens/image at any size; Claude caps at 4,784
  visual tokens). Evidence-backed with 200k-token evals, genuinely clever, and
  HARD-NEEDS-FORK: history rewrite + vision gating + per-provider billing math.
- **Retry/fallback policy** — `min(500 * 2^(n-1), 8000)` with 75–100% jitter,
  credential rotation, replay-safety check blocking retry once visible output
  emitted. Correct and subtle, but inside the agent loop.
- **Prewalk** (mid-turn strong→cheap model handoff at first edit after todos
  exist), **context promotion** (overflow fallback chains before compaction),
  **session tree**, **pi-walker scan cache**, **PTY overlay**, **collab relay**.

Two Rust details worth remembering even though the cache is fork-only:
**fail-open regex** (`crates/pi-natives/src/grep.rs` — braces that cannot form
`{N,M}` are auto-escaped, so `${platform}` searches literally instead of
erroring) and `maxCountPerFile` (stops one hot file eating the global match
budget). Both are EASY to add to any grep wrapper.

## Suggested build order

`omp-lite` extension with 1 → 2 → 3 → 4 (no new concepts, testable end to end),
then 6, then 5's non-interrupt tier, then 7, then 9. Live in `extensions/` here;
`sync.sh` and `bootstrap.sh` already handle it.
