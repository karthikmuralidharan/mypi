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

# require CMD... — assert each command exists.
require() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "missing required tool: $c"; done; }

# require_config — die unless setup has run and a JIRA project is configured.
require_config() {
    [ -n "${LOOP_DIR:-}" ] && [ -f "$_cfg" ] || die "no .loop/config.json found — run: scripts/loop/loop setup"
    [ -n "${JIRA_PROJECT:-}" ] || die "jira.project not set in $_cfg — run: scripts/loop/loop setup"
}

require curl jq gh
