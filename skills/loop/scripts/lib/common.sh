#!/usr/bin/env bash
# common.sh — shared helpers for the loop traceability scripts.
#
# Sourced by every loop/*.sh script. Provides:
#   - repo-agnostic config discovery (.loop/config.json, walked up from cwd)
#   - Atlassian (Jira) auth (environment variables)
#   - jira_curl / gh helpers, logging, and JSON escaping
#
# Nothing here is repo-specific: JIRA project key, site, and GH repo all come
# from config (written by `loop setup`) or env overrides. No secrets are
# printed.
set -euo pipefail

# ---------------------------------------------------------------------------
# Config and run state belong to the current Git worktree.
worktree_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
LOOP_DIR="${worktree_root:+$worktree_root/.loop}"
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

configured_jira_site="$(cfg '.jira.site')"
JIRA_SITE="${ATLASSIAN_SITE:-}"
JIRA_PROJECT="${LOOP_JIRA_PROJECT:-$(cfg '.jira.project')}"
export JIRA_SITE JIRA_PROJECT LOOP_DIR

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
# Jira credentials come from the environment.
# ---------------------------------------------------------------------------
require_jira_site() {
    [[ "$JIRA_SITE" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "set ATLASSIAN_SITE to the trusted Jira hostname"
    [ -z "$configured_jira_site" ] || [ "$configured_jira_site" = "$JIRA_SITE" ] ||
        die "jira.site in .loop/config.json differs from the trusted ATLASSIAN_SITE"
}

load_atlassian_creds() {
    [ -n "${ATLASSIAN_EMAIL:-}" ] || die "ATLASSIAN_EMAIL is required"
    [ -n "${ATLASSIAN_API_TOKEN:-}" ] || die "ATLASSIAN_API_TOKEN is required"
}

# Retry transient server errors on reads. A failed write can have taken effect.
jira_curl() {
    local method="$1" path="$2"
    shift 2
    require_jira_site
    load_atlassian_creds
    local out code attempt=0 max=3
    while :; do
        attempt=$((attempt + 1))
        out="$(curl -q -sS --proto '=https' --connect-timeout 10 --max-time 45 \
            -w $'\n%{http_code}' -u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
            -H 'Content-Type: application/json' -H 'Accept: application/json' \
            -X "$method" "https://${JIRA_SITE}/rest/api/3${path}" "$@")" || die "jira_curl network failure ($method $path)"
        code="${out##*$'\n'}"
        out="${out%$'\n'*}"
        if [ "$method" = GET ] && [ "$code" -ge 500 ] && [ "$attempt" -lt "$max" ]; then
            warn "JIRA $method $path -> HTTP $code (transient), retry $attempt/$((max - 1))"
            sleep $((attempt * 2))
            continue
        fi
        break
    done
    if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
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
# Git moves or removes branch config when a branch is renamed or deleted.
# An opaque run ID prevents a new branch from inheriting old approvals.
branch_run() {
    local branch="$1" id
    git show-ref --verify --quiet "refs/heads/$branch" || return 1
    id="$(git config --local --get "branch.$branch.loop-run")" || return 1
    [[ "$id" =~ ^[a-f0-9]{32}$ ]] || return 1
    printf '%s\n' "$id"
}

state_file() {
    local branch="${1:-$(git branch --show-current)}" id path owner target
    [ -n "$LOOP_DIR" ] && [ ! -L "$LOOP_DIR" ] || return 1
    [ -n "$branch" ] || return 1
    id="$(branch_run "$branch")" || return 1
    path="$LOOP_DIR/state/v3/$id.json"
    [ -f "$path" ] || return 1
    owner="$(jq -er '.branch' "$path")" || return 1
    if [ "$owner" != "$branch" ]; then
        target="$(jq -r '.renameTo // empty' "$path")" || return 1
        [ "$target" = "$branch" ] && ! git show-ref --verify --quiet "refs/heads/$owner" || return 1
    fi
    printf '%s\n' "$path"
}

start_run() {
    local branch id path
    branch="$(git branch --show-current)"
    git show-ref --verify --quiet "refs/heads/$branch" || die "check out an existing local work branch"
    id="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
    mkdir -p "$LOOP_DIR/state/v3"
    path="$LOOP_DIR/state/v3/$id.json"
    jq -n --arg branch "$branch" '{branch:$branch}' >"$path"
    git config --local "branch.$branch.loop-run" "$id"
    printf '%s\n' "$id"
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

# Merge one field under a kernel lock. Rename the complete file into place so
# readers see either the old state or the new state.
state_set() {
    state_set_json "$1" "$(jq -n --arg value "$2" '$value')" "${3:-}"
}

state_set_json() {
    local path
    path="$(state_file "${3:-}")" || die "no active loop run; run loop start"
    python3 - "$path" "$1" "$2" <<'PYTHON'
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile

state_path = Path(sys.argv[1])
field = sys.argv[2]
value = json.loads(sys.argv[3])
with state_path.with_suffix(".lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    state[field] = value
    fd, temporary = tempfile.mkstemp(dir=state_path.parent, prefix=".state-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, state_path)
    finally:
        Path(temporary).unlink(missing_ok=True)
PYTHON
}

# require_gate N — read the approval recorded for this branch.
require_gate() {
    local n="$1"
    local approved
    approved="$(state_read ".gate${n}.approved" false "${2:-}")"
    [ "$approved" = "true" ] || die "gate $n is not recorded as passed. Get human approval, then run: loop gate-pass $n."
}

approved_spec_hash() {
    local branch="${1:-}" file hash
    require_gate 1 "$branch"
    file="$(state_read '.gate1.specFile' '' "$branch")"
    hash="$(state_read '.gate1.specHash' '' "$branch")"
    [ -n "$hash" ] && [ -f "$file" ] && [ "$(git hash-object --no-filters -- "$file")" = "$hash" ] ||
        die "the approved spec is missing or changed; record approval for the current spec"
    printf '%s\n' "$hash"
}

approved_ticket_scope() {
    local branch="${1:-}" hash scope
    require_gate 2 "$branch"
    require_jira_site
    hash="$(approved_spec_hash "$branch")"
    [ "$hash" = "$(state_read '.gate2.specHash' '' "$branch")" ] || die "ticket approval does not match the approved spec"
    scope="$(state_read '.gate2.scope' '' "$branch")"
    jq -ce --arg repo "$(gh_repo)" --arg site "$JIRA_SITE" --arg project "$JIRA_PROJECT" '
        select(type == "object" and .repo == $repo and .site == $site and .project == $project)
    ' <<<"$scope" || die "record ticket approval for this GitHub repository and Jira project"
}

parent_creation_id() {
    { jq -r '.repo, "parent", .site, .project, .epic, .title' <<<"$1"; printf '%s\n' "$2"; } |
        git hash-object --stdin
}

github_body_hash() {
    jq -erj '.body // ""' <<<"$1" | git hash-object --stdin
}

github_body_matches() {
    local data="$1" file="$2" operation="$3" backlink="$4"
    jq -e --rawfile approved "$file" --arg operation "$operation" --arg backlink "$backlink" '
        def clean: gsub("\r\n"; "\n") | sub("\n+$"; "");
        def remove_suffix($suffix): .[0:-( $suffix | length )] | clean;
        (.body // "" | clean) |
        (if $backlink != "" and endswith("\n\n---\n" + $backlink)
         then remove_suffix("\n\n---\n" + $backlink) else . end) |
        (if $operation == "" then . elif endswith("\n" + $operation)
         then remove_suffix($operation) else empty end) == ($approved | clean)
    ' <<<"$data" >/dev/null
}

approved_parent() {
    local scope="$1" hash="$2" number="${3#\#}" branch="${4:-}" data="${5:-}" marker="" jira backlink=""
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || die "create or adopt the approved GitHub issue first"
    if [ "$(jq -r '.issue' <<<"$scope")" = null ]; then
        marker="<!-- loop-operation:$(parent_creation_id "$scope" "$hash") -->"
    else
        [ "$(jq -r '.issue' <<<"$scope")" = "$number" ] || die "the tracked issue differs from the approved issue"
    fi
    if [ -z "$data" ]; then
        data="$(gh issue view "$number" --repo "$(jq -er .repo <<<"$scope")" --json number,title,body)" || return 1
    fi
    jq -e --argjson scope "$scope" --arg number "$number" '
        (.number | tostring) == $number and .title == $scope.title
    ' <<<"$data" >/dev/null || die "GitHub issue #$number does not match the approved scope"
    jira="$(state_read '.jira' '' "$branch")"
    [ -z "$jira" ] || backlink="$(jira_link_line "$jira")"
    github_body_matches "$data" "$(state_read '.gate1.specFile' '' "$branch")" "$marker" "$backlink" ||
        die "GitHub issue #$number body differs from the approved spec"
    printf '%s\n' "$number"
}

# Use the story recorded for this run. A matching project prefix is insufficient.
require_jira_ticket() {
    local ticket
    ticket="$(state_read '.jira' '' "$1")"
    [[ "$ticket" =~ ^[A-Z][A-Z0-9_]*-[0-9]+$ ]] ||
        die "no valid Jira ticket is recorded for $1; finish the Jira mirror first"
    printf '%s\n' "$ticket"
}

jira_branch_matches() {
    case "$1" in
        "$2" | "$2"-* | "$2"/*) return 0 ;;
        *) return 1 ;;
    esac
}

jira_title_matches() {
    case "$1" in
        "$2" | "$2 "* | "$2:"*) return 0 ;;
        *) return 1 ;;
    esac
}

jira_pr_names_match() {
    local branch="$1" ticket="$2" pr_data="$3" title
    jira_branch_matches "$branch" "$ticket" || return 1
    jq -e --arg branch "$branch" '.headRefName == $branch' <<<"$pr_data" >/dev/null || return 1
    title="$(jq -er '.title' <<<"$pr_data")" || return 1
    jira_title_matches "$title" "$ticket"
}

github_issue_url() {
    printf 'https://github.com/%s/issues/%s\n' "$1" "$2"
}

jira_link_line() {
    printf 'JIRA: %s (https://%s/browse/%s)\n' "$1" "$JIRA_SITE" "$1"
}

# Match one full source URL in the Jira description. The caller also checks
# the Jira project, type, and parent before changing anything.
jira_has_github_url='any(.fields.description | .. | strings | scan("https://[^[:space:]<>]+"); . == $url)'

jira_issue_snapshot() {
    local key="$1"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*-[0-9]+$ ]] || die "invalid Jira issue key: $key"
    jira_curl GET "/issue/$key?fields=description,parent,project,issuetype,status"
}

jira_mirror_matches() {
    local repo="$1" number="$2" parent="$3" type="$4" data="$5"
    jq -e --arg url "$(github_issue_url "$repo" "$number")" --arg parent "$parent" \
        --arg project "$JIRA_PROJECT" --arg type "$type" '
            .fields.parent.key == $parent and .fields.project.key == $project and
            .fields.issuetype.name == $type and '"$jira_has_github_url" \
        <<<"$data" >/dev/null
}

jira_mirror() {
    local repo="$1" key="$2" number="$3" parent="$4" type="$5" data
    data="$(jira_issue_snapshot "$key")" || return 1
    jira_mirror_matches "$repo" "$number" "$parent" "$type" "$data" ||
        die "$key does not mirror GitHub issue #$number under $parent as a $type"
    printf '%s\n' "$data"
}

run_identity() {
    local branch="$1" scope hash issue ticket
    scope="$(approved_ticket_scope "$branch")" || return 1
    hash="$(state_read '.gate2.specHash' '' "$branch")"
    issue="$(approved_parent "$scope" "$hash" "$(state_read '.issue' '' "$branch")" "$branch")" || return 1
    ticket="$(require_jira_ticket "$branch")" || return 1
    jira_mirror "$(jq -er .repo <<<"$scope")" "$ticket" "$issue" "$(jq -er .epic <<<"$scope")" Story >/dev/null || return 1
    run_fingerprint "$branch" "$scope" "$hash" "$issue" "$ticket"
}

run_fingerprint() {
    local id
    id="$(branch_run "$1")" || return 1
    shift
    printf '%s\n' "$id" "$@" | git hash-object --stdin
}

pr_closes_issue() {
    local repo="$1" issue="$2" data="$3"
    jq -e --arg repo "$repo" --arg number "$issue" --arg url "$(github_issue_url "$repo" "$issue")" '
        any(.closingIssuesReferences[]?;
            .url == $url or ((.number | tostring) == $number and
                ((.repository.owner.login // "") + "/" + (.repository.name // "")) == $repo))
    ' <<<"$data" >/dev/null
}

pr_snapshot() {
    local fields=number,state,url,headRefOid,headRefName,headRepository,headRepositoryOwner,baseRefName,title,closingIssuesReferences,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
    gh pr view "$2" --repo "$1" --json "$fields"
}

pr_binding_matches() {
    local binding="$1" branch="$2" ticket="$3" data="$4"
    jira_pr_names_match "$branch" "$ticket" "$data" || return 1
    jq -e --argjson binding "$binding" '
        (.number | tostring) == $binding.number and .baseRefName == $binding.base and
        (.headRepository.nameWithOwner //
            ((.headRepositoryOwner.login // .headRepository.owner.login // "") + "/" + (.headRepository.name // ""))) == $binding.headRepo
    ' <<<"$data" >/dev/null || return 1
    case "$(jq -r '.mode' <<<"$binding")" in
        partial) return 0 ;;
        full) pr_closes_issue "$(jq -r '.repo' <<<"$binding")" "$(jq -r '.issue' <<<"$binding")" "$data" ;;
        *) return 1 ;;
    esac
}

require_pr_binding() {
    local branch="$1" run="$2" binding
    binding="$(state_read '.prBinding' '' "$branch")"
    [ -n "$binding" ] || die "bind the pull request with loop bind-pr first"
    jq -ce --arg run "$run" 'select(.run == $run)' <<<"$binding" ||
        die "the PR binding is stale; bind the pull request for the current approval"
}

evidence_identity() {
    local branch="$1" head="$2" run="$3" kind record file hash
    for kind in tests review; do
        record="$(state_read ".evidence_$kind" '' "$branch")"
        file="$(jq -er --arg head "$head" --arg run "$run" 'select(.head == $head and .run == $run) | .file' <<<"$record")" ||
            die "record $kind evidence for commit $head and the current approval"
        [ -n "$file" ] && [ -f "$file" ] || die "the $kind evidence file is missing"
        hash="$(git hash-object --no-filters -- "$file")" || return 1
        [ "$hash" = "$(jq -er '.sha' <<<"$record")" ] || die "the $kind evidence file changed; record it again"
        printf '%s:%s\n' "$kind" "$hash"
    done
}

# require CMD... — assert each command exists.
require() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "missing required tool: $c"; done; }

# require_config — die unless setup has run and a JIRA project is configured.
require_config() {
    [ -n "${LOOP_DIR:-}" ] && [ ! -L "$LOOP_DIR" ] && [ -f "$_cfg" ] ||
        die "no worktree-local .loop/config.json found; run loop setup"
    [ -n "${JIRA_PROJECT:-}" ] || die "jira.project not set in $_cfg — run: loop setup"
}

require curl jq gh
