---
name: "eng-loop-jira-gh-sync-tooling"
description: "Build/maintain the repo-agnostic /loop skill and its GitHub-issue↔JIRA traceability scripts (Atlassian REST curl+jq, gh sub-issues)."
version: 2
created: "2026-07-26"
updated: "2026-07-26"
---
## When to Use
When extending the global `loop` skill (~/.pi/agent/skills/loop/) or its scripts, or building similar GH↔JIRA sync tooling with Atlassian REST + gh CLI. Repo-agnostic: config in per-repo .loop/config.json (gitignored), no project key hardcoded.

## Procedure
1. Scripts live GLOBALLY at ~/.pi/agent/skills/loop/scripts/ (loop entrypoint, sync.sh, find-epic.sh, ci-watch.sh, pr-check.sh, ship-gate.sh, lib/common.sh); the SKILL.md (name: loop) is beside them. Per-repo config is .loop/config.json (gitignored), written by `loop setup`. NOTE: skill/command/entrypoint/label/env-vars are all named `loop` (renamed from eng-loop); env overrides are LOOP_DIR/LOOP_JIRA_PROJECT/LOOP_GH_REPO; dot-folder is .loop/; gh label is `loop`.
2. common.sh discovers config by walking up from cwd for .loop/config.json; cfg() reads jq paths; JIRA_PROJECT/JIRA_SITE/GH_REPO all come from config or env — never hardcode SWONE.
3. Atlassian creds: env ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN, else parse ~/.config/fish/config_secrets.fish (bash can't source fish). HTTP Basic. Never print the token.
4. jira_curl retries transient 5xx (Jira Cloud throws intermittent HTTP 500 from a Postgres nextval() sequence hiccup — real, not a bug); 4xx fails immediately.
5. JIRA team-managed projects link Story→Epic via fields.parent.key (NOT the classic epic-link customfield). Sub-task→Story also via fields.parent. Create/description bodies need ADF (adf_doc wraps text).
6. Idempotency: stamp JIRA issues with label gh-issue-<n>; find_jira_by_gh looks it up so mirror-* re-runs no-op. Bidirectional link = JIRA remote link (globalId=GH url, upsert) + `JIRA: <KEY>` body marker + gh label jira:<KEY>.
7. gh sub-issues use GraphQL: fetch issue node ids, then mutation addSubIssue(input:{issueId,subIssueId}). Single-quoted GraphQL $vars are intentional (shellcheck SC2016 is a false positive here) — pr-check.sh's reviewThreads query is the same pattern.
8. `gh_repo()` in common.sh is the single source of truth for resolving owner/repo (env LOOP_GH_REPO, else .loop/config.json's gh.repo, else `gh repo view`). sync.sh and pr-check.sh both call it — don't re-derive the fallback chain in a new script; call gh_repo instead. `jql_escape()` in common.sh is the same idea for free-text JQL interpolation (find-epic.sh's keyword search) — an unescaped `"` or `\` in a human's search term breaks the JQL literal.
9. `ship-gate.sh` composes `ci-watch.sh` + `pr-check.sh` into one call/one exit code (always runs both, even if the first fails, so neither check hides the other). `sync bootstrap` composes `create-issue` → `mirror-jira` → per-`--subitem` `add-subissue`+`mirror-subtask` into one call after GATE 2 — built entirely from the existing `cmd_*` functions called directly (not re-implemented), so the idempotency/labeling guarantees carry over unchanged. When adding a new composite script, prefer this pattern (call the existing primitives, don't duplicate their logic) over hand-rolling the API calls again.
10. Verify write path live: create throwaway issue, mirror twice (assert same key = idempotent), add sub-issue+sub-task, check fields.parent + subtasks + body marker + labels, then clean up (JIRA DELETE works; gh issue delete may lack perms — close as 'not planned' instead).
11. When renaming the skill or adding/removing a subcommand line in the entrypoint's header comment: the entrypoint has a SELF-reference `sed -n '<start>,<end>p' "$HERE/<name>"` for --help. The range's end line must track the current line count of (header comment + the `set -euo pipefail`/HERE=/source lines right after it) — adding a subcommand doc line shifts every line below it by one; recount after any edit to the header block, don't assume the old range still lands on `source`. Also migrate the per-repo dot-folder and its .gitignore entry when renaming.
## Pitfalls
- gh issue edit/create and gh issue edit --body-file - PRINT the issue URL to stdout — redirect >/dev/null in side-effect helpers (cmd_link) or the URL leaks into $(...) command substitution and corrupts the returned key.
- gh issue edit --add-label will NOT auto-create a missing label; run `gh label create` first or the label silently doesn't attach.
- The Go/bash auto-formatter rewrites unquoted associative-array subscripts with hyphens: ARGS[body-file] becomes ARGS[body - file] (arithmetic). Always quote: ARGS["body-file"].
- gh label create prints to stdout when the label already exists — redirect both >/dev/null 2>&1, not just stderr.
- shellcheck SC1091 (can't follow dynamic source path) and SC2016 (GraphQL single-quote $vars) are benign here — filter them, don't 'fix'.
- gh issue delete needs elevated repo perms; a normal token gets 'Viewer not authorized to delete' — close instead.

## Verification
1. shellcheck -x on all scripts shows only SC1091/SC2016.
2. `loop config` prints resolved site/project/gh from .loop/config.json.
3. `loop find-epic <kw>` returns candidate epics (auth + project OK).
4. mirror-jira/mirror-subtask re-runs return the SAME key with a '(no-op)' log line; stdout is EXACTLY the key (no leaked URLs).
5. Mirrored JIRA issue's fields.parent.key equals the confirmed epic; sub-task appears in parent .fields.subtasks; GH body has `JIRA: <KEY>` marker and jira:<KEY> label.
6. `loop pr-check` on a branch with an open PR prints `reviewDecision` + unresolved-thread counts on stdout and exits 0 when clear / 1 when `CHANGES_REQUESTED` or any unresolved thread exists.
7. `loop sync auto-status --jira <KEY> --pr <n>` picks the right transition off the PR's real `state` (OPEN/MERGED/CLOSED) without a `--to` argument, and no-ops on a closed-unmerged PR instead of reverting status.
8. `loop ship-gate` runs `ci-watch` then `pr-check` unconditionally (even if the first fails) and exits 0 only when both did — confirm a deliberately-failing branch still gets a pr-check summary, not just the ci-watch failure.
9. `sync bootstrap --title T --body-file F --epic K --subitem A --subitem B` produces the same GH issue + JIRA story + 2 sub-issues + 2 JIRA sub-tasks as running create-issue/mirror-jira/add-subissue×2/mirror-subtask×2 by hand, and prints one JSON object with `.issue`, `.jira`, `.subissues[]`.
10. `loop --help` output ends at the `source "$HERE/lib/common.sh"` line, not mid-comment or spilling into unrelated code — confirms the sed range in the entrypoint still matches the header block's actual line count.