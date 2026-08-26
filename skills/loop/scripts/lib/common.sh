#!/usr/bin/env bash
# common.sh — shared helpers for the loop traceability scripts.
#
# Sourced by every loop/*.sh script. Provides:
#   - repo-agnostic config discovery (.loop/config.json, walked up from cwd)
#   - Atlassian (Jira) auth (env, else ~/.config/fish/config_secrets.fish)
#   - jira_curl / gh helpers, logging, and JSON escaping
#
# Nothing here is repo-specific: JIRA project key, site, and GH repo all come
# from config (written by `loop setup`) or env overrides. No secrets are
# ever printed. bash does not auto-source the fish secrets file, so we parse
# the ATLASSIAN_* values out of it directly (per the atlassian-rest-cli skill).
set -euo pipefail

# ---------------------------------------------------------------------------
# Config discovery. Find the nearest .loop/config.json by walking up from
# the current directory (so scripts work from anywhere in the repo). Values
# may be overridden by env for CI/one-offs. No hardcoded project or site.
# ---------------------------------------------------------------------------
find_config_dir() {
    local d
    d="$(pwd)"
    while [ "$d" != "/" ]; do
        [ -f "$d/.loop/config.json" ] && {
            echo "$d/.loop"
            return 0
        }
        d="$(dirname "$d")"
    done
    return 1
}

LOOP_DIR="${LOOP_DIR:-$(find_config_dir || true)}"
_cfg="${LOOP_DIR:+$LOOP_DIR/config.json}"

cfg() { # cfg <jq-path> [default] — read a value from config.json
    local path="$1" def="${2:-}"
    [ -n "${_cfg:-}" ] && [ -f "$_cfg" ] || {
        printf '%s' "$def"
        return
    }
    local v
    v="$(jq -r "$path // empty" "$_cfg" 2>/dev/null)"
    printf '%s' "${v:-$def}"
}

JIRA_SITE="${ATLASSIAN_SITE:-$(cfg '.jira.site' 'swicloud.atlassian.net')}"
JIRA_PROJECT="${LOOP_JIRA_PROJECT:-$(cfg '.jira.project')}"
JIRA_API="https://${JIRA_SITE}/rest/api/3"
export JIRA_SITE JIRA_PROJECT JIRA_API LOOP_DIR

# ---------------------------------------------------------------------------
# Logging (stderr, so stdout stays machine-parseable).
# ---------------------------------------------------------------------------
log() { printf '\033[36m[loop]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[loop] WARN:\033[0m %s\n' "$*" >&2; }
die() {
    printf '\033[31m[loop] ERROR:\033[0m %s\n' "$*" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# Credentials. Prefer env (CI / already-exported), fall back to the fish
# secrets file for local dev. Never echo the token.
# ---------------------------------------------------------------------------
_secrets_file="${ATLASSIAN_SECRETS_FILE:-$HOME/.config/fish/config_secrets.fish}"

_parse_secret() { # $1 = var name
    [ -f "$_secrets_file" ] || return 1
    grep -m1 "$1" "$_secrets_file" 2>/dev/null |
        sed -E "s/.*$1 ['\"]?([^'\"]+).*/\1/"
}

load_atlassian_creds() {
    : "${ATLASSIAN_EMAIL:=$(_parse_secret ATLASSIAN_EMAIL || true)}"
    : "${ATLASSIAN_API_TOKEN:=$(_parse_secret ATLASSIAN_API_TOKEN || true)}"
    [ -n "${ATLASSIAN_EMAIL:-}" ] || die "ATLASSIAN_EMAIL not set and not found in $_secrets_file"
    [ -n "${ATLASSIAN_API_TOKEN:-}" ] || die "ATLASSIAN_API_TOKEN not set and not found in $_secrets_file"
    export ATLASSIAN_EMAIL ATLASSIAN_API_TOKEN
}

# jira_curl METHOD PATH [curl-args...]  — PATH is relative to $JIRA_API.
# Emits the response body on stdout. Retries transient 5xx (Jira Cloud
# occasionally returns a 500 from a Postgres sequence hiccup). Fails hard on
# 4xx immediately, and on 5xx after exhausting retries, showing the body.
jira_curl() {
    local method="$1" path="$2"
    shift 2
    load_atlassian_creds
    local out code attempt=0 max=3
    while :; do
        attempt=$((attempt + 1))
        out="$(curl -sS -w $'\n%{http_code}' -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
            -H 'Content-Type: application/json' -H 'Accept: application/json' \
            -X "$method" "${JIRA_API}${path}" "$@")" || die "jira_curl network failure ($method $path)"
        code="${out##*$'\n'}"
        out="${out%$'\n'*}"
        if [ "$code" -ge 500 ] && [ "$attempt" -lt "$max" ]; then
            warn "JIRA $method $path -> HTTP $code (transient), retry $attempt/$((max - 1))"
            sleep $((attempt * 2))
            continue
        fi
        break
    done
    if [ "$code" -ge 400 ]; then
        die "JIRA $method $path -> HTTP $code: $(printf '%s' "$out" | jq -c '.errors // .errorMessages // .' 2>/dev/null || printf '%s' "$out")"
    fi
    printf '%s' "$out"
}

# jira_verify — 200 on /myself or die. Prints the display name.
jira_verify() {
    local who
    who="$(jira_curl GET /myself | jq -r '.displayName // empty')"
    [ -n "$who" ] || die "JIRA auth failed (no displayName)"
    log "JIRA auth OK as: $who"
}

# adf_doc TEXT — wrap plain text in a minimal Atlassian Document Format doc
# (Jira Cloud v3 create/description fields require ADF, not raw strings).
adf_doc() {
    jq -Rs '{type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text:.}]}]}' <<<"$1"
}

# jql_escape TEXT — escape a string for safe interpolation into a JQL
# double-quoted literal (backslash first, then double-quote — standard
# escaping order). Use this for any free-text human input going into a jql=
# string; numeric/label-derived values (e.g. gh-issue-<n>) don't need it.
jql_escape() {
    local s="${1//\\/\\\\}"
    printf '%s' "${s//\"/\\\"}"
}

# gh_repo — resolve "owner/repo" once: env override, else config, else `gh`.
# Shared so every script that needs the GH repo (sync.sh, pr-check.sh, ...)
# resolves it the same way instead of re-deriving the fallback chain.
gh_repo() {
    local r="${LOOP_GH_REPO:-$(cfg '.gh.repo')}"
    [ -n "$r" ] || r="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
    printf '%s' "$r"
}

# ---------------------------------------------------------------------------
# Run state: one JSON file per branch at .loop/state/<branch>.json (slashes
# become __ for a safe filename). Tracks facts a long-running /loop session
# must not lose across turns, compaction, or a resumed session: the two hard
# gates' approval record, the tracked issue/JIRA key, and the last commit
# that cleared the ship gate. `loop where` reads this back and cross-checks
# it against live gh/JIRA/git state — see status.sh.
#
# Every writer here is a small, composable primitive in the same style as
# cfg(): state_set/state_set_json write ONE field with an atomic merge (tmp
# file + rename), so a script interrupted mid-write cannot corrupt the file
# for the next reader. Values always go through jq --arg/--argjson, never
# string interpolation, so a free-text --note field with quotes or
# backslashes cannot break the JSON or inject into the filter.
# ---------------------------------------------------------------------------

# state_file [branch] — path to a branch's run-state file (default: current
# branch). Dies with a clear message on detached HEAD, since state needs a
# stable key to bucket by.
state_file() {
    local branch="${1:-}"
    [ -n "$branch" ] || branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || die "not in a git repository"
    [ -n "$branch" ] && [ "$branch" != "HEAD" ] || die "detached HEAD has no branch to key state on — pass one explicitly"
    local dir
    dir="${LOOP_DIR:?run 'loop setup' first}/state"
    mkdir -p "$dir"
    printf '%s/%s.json' "$dir" "${branch//\//__}"
}

# state_read PATH [default] [branch] — read one jq path from a branch's
# state file. Missing file or missing path both fall back to [default],
# same contract as cfg().
state_read() {
    local path="$1" def="${2:-}" branch="${3:-}"
    local f
    f="$(state_file "$branch" 2>/dev/null)" || {
        printf '%s' "$def"
        return
    }
    [ -f "$f" ] || {
        printf '%s' "$def"
        return
    }
    local v
    v="$(jq -r "$path // empty" "$f" 2>/dev/null)"
    printf '%s' "${v:-$def}"
}

# state_set FIELD VALUE [branch] — set one top-level field to a string,
# merged atomically into the existing state (creating it on first write).
state_set() {
    local field="$1" value="$2" branch="${3:-}"
    local f cur tmp
    f="$(state_file "$branch")"
    cur='{}'
    [ -f "$f" ] && cur="$(cat "$f")"
    tmp="$f.tmp.$$"
    printf '%s' "$cur" | jq --arg v "$value" ".${field} = \$v" >"$tmp" || {
        rm -f "$tmp"
        die "state_set: jq failed for field '$field'"
    }
    mv "$tmp" "$f"
}

# state_set_json FIELD JSON [branch] — set one top-level field to a JSON
# value (object, bool, number), e.g. state_set_json gate1 '{"approved":true}'.
state_set_json() {
    local field="$1" json="$2" branch="${3:-}"
    local f cur tmp
    f="$(state_file "$branch")"
    cur='{}'
    [ -f "$f" ] && cur="$(cat "$f")"
    tmp="$f.tmp.$$"
    printf '%s' "$cur" | jq --argjson v "$json" ".${field} = \$v" >"$tmp" || {
        rm -f "$tmp"
        die "state_set_json: jq failed for field '$field' (is the JSON valid?)"
    }
    mv "$tmp" "$f"
}

# require_gate N — die unless gate N (1 or 2) is recorded as passed in this
# branch's state. LOOP_SKIP_GATE_CHECK=1 bypasses the check (loud, logged) —
# for standalone use of sync.sh outside the full /loop pipeline (the
# integration-test workflow in eng-loop-jira-gh-sync-tooling's own
# Verification section calls sync bootstrap directly), not for skipping a
# real gate on a real run.
require_gate() {
    local n="$1"
    if [ "${LOOP_SKIP_GATE_CHECK:-}" = "1" ]; then
        warn "LOOP_SKIP_GATE_CHECK=1 -- gate $n check bypassed"
        return 0
    fi
    local approved
    approved="$(state_read ".gate${n}.approved" false)"
    [ "$approved" = "true" ] || die "gate $n is not recorded as passed. Get human approval, then run: loop gate-pass $n. (Standalone or test use: set LOOP_SKIP_GATE_CHECK=1.)"
}

# require CMD... — assert each command exists.
require() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "missing required tool: $c"; done; }

# require_config — die unless setup has run and a JIRA project is configured.
require_config() {
    [ -n "${LOOP_DIR:-}" ] && [ -f "$_cfg" ] || die "no .loop/config.json found — run: scripts/loop/loop setup"
    [ -n "${JIRA_PROJECT:-}" ] || die "jira.project not set in $_cfg — run: scripts/loop/loop setup"
}

require curl jq gh
