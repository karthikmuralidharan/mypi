#!/usr/bin/env bash
# sync.sh — GH issue <-> JIRA story traceability for the loop.
#
# The GitHub issue body is the SOURCE OF TRUTH (product spec + tech spec +
# behaviour criteria). JIRA MIRRORS the hierarchy for org-level reporting.
# This script keeps the two in lockstep and is idempotent: re-running never
# creates duplicates. It links both ways so either system reaches the other.
#
# Subcommands:
#   create-issue   --title T --body-file F [--label L]...      -> prints "#<n>"
#   mirror-jira    --gh <n> --epic SWONE-K [--type Story]       -> prints JIRA key
#   add-subissue   --parent <n> --title T [--body-file F]       -> prints "#<n>"
#   mirror-subtask --gh <n> --jira-parent SWONE-K               -> prints JIRA key
#   link           --gh <n> --jira SWONE-K                       (idempotent xlink)
#   status         --jira SWONE-K --to "In Progress"|"Done"|...
#   auto-status    --jira SWONE-K --pr <n>                        (deterministic PR-state -> status)
#   bootstrap      --title T --body-file F --epic K [--subitem T]...  (GATE-2 sequence, one call)
#
# Every JIRA issue we create is tagged with GH coordinates and vice-versa, so
# the link subcommand and all mirror-* subcommands can detect an existing
# counterpart and no-op instead of duplicating.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_config

GH_REPO="$(gh_repo)"

# --- arg parsing helper: reads --flag value pairs into assoc array ARGS ------
declare -A ARGS
parse_args() { while [ $# -gt 0 ]; do case "$1" in --*)
    ARGS["${1#--}"]="$2"
    shift 2
    ;;
*) die "unexpected arg: $1" ;; esac done }

# --- gh issue url for a number (used in JIRA remote link + body markers) -----
gh_issue_url() { echo "https://github.com/${GH_REPO}/issues/$1"; }

# ---------------------------------------------------------------------------
# create-issue: the GH issue that owns the spec. Tagged loop for discovery.
# ---------------------------------------------------------------------------
cmd_create_issue() {
    require_gate 2
    parse_args "$@"
    local title="${ARGS[title]:?--title required}" body_file="${ARGS["body-file"]:?--body-file required}"
    local labels="loop"
    [ -n "${ARGS[label]:-}" ] && labels="$labels,${ARGS[label]}"
    gh label create loop --color 5319e7 --description "Managed by /loop" >/dev/null 2>&1 || true
    local url
    url="$(gh issue create --repo "$GH_REPO" --title "$title" --body-file "$body_file" --label "$labels")"
    local num="${url##*/}"
    state_set issue "#$num"
    log "created GH issue #$num — $title"
    echo "#$num"
}

# ---------------------------------------------------------------------------
# add-subissue: create a child GH issue and attach it as a REAL sub-issue
# (GraphQL addSubIssue), not just a checklist item.
# ---------------------------------------------------------------------------
cmd_add_subissue() {
    require_gate 2
    parse_args "$@"
    local parent="${ARGS[parent]:?--parent required}" title="${ARGS[title]:?--title required}"
    local body="${ARGS["body-file"]:-/dev/null}"
    gh label create loop --color 5319e7 >/dev/null 2>&1 || true
    local url
    url="$(gh issue create --repo "$GH_REPO" --title "$title" --body-file "$body" --label loop)"
    local child="${url##*/}"
    local pid cid
    pid="$(gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id}}}' \
        -f o="${GH_REPO%/*}" -f r="${GH_REPO#*/}" -F n="${parent#\#}" -q .data.repository.issue.id)"
    cid="$(gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id}}}' \
        -f o="${GH_REPO%/*}" -f r="${GH_REPO#*/}" -F n="$child" -q .data.repository.issue.id)"
    gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}' \
        -f p="$pid" -f c="$cid" >/dev/null
    log "created GH sub-issue #$child under #$parent"
    echo "#$child"
}

# ---------------------------------------------------------------------------
# find_jira_by_gh: return an existing JIRA key mirroring a GH issue, if any.
# We stamp a label gh-issue-<n> on every mirrored JIRA issue for idempotency.
# ---------------------------------------------------------------------------
find_jira_by_gh() {
    local n="${1#\#}"
    jira_curl GET "/search/jql" -G \
        --data-urlencode "jql=project = ${JIRA_PROJECT} AND labels = gh-issue-${n}" \
        --data-urlencode "fields=key" | jq -r '.issues[0].key // empty'
}

# ---------------------------------------------------------------------------
# mirror-jira: create (or find) a JIRA Story under a confirmed epic, mirroring
# a GH issue. Sets fields.parent to the epic (team-managed hierarchy; verified
# SWONE-232's parent is the SWONE-2 epic via .fields.parent, not epic-link).
# ---------------------------------------------------------------------------
cmd_mirror_jira() {
    require_gate 2
    parse_args "$@"
    local gh_n="${ARGS[gh]:?--gh required}" epic="${ARGS[epic]:?--epic required}" itype="${ARGS[type]:-Story}"
    local existing
    existing="$(find_jira_by_gh "$gh_n")"
    if [ -n "$existing" ]; then
        log "JIRA already mirrors #${gh_n#\#}: $existing (no-op)"
        state_set jira "$existing"
        echo "$existing"
        return
    fi

    local title body_desc
    title="$(gh issue view "${gh_n#\#}" --repo "$GH_REPO" --json title -q .title)"
    body_desc="$(printf 'Mirrors GitHub issue %s\n\nSpec source of truth lives in the GitHub issue body.' "$(gh_issue_url "${gh_n#\#}")")"

    local payload
    payload="$(jq -n --arg proj "$JIRA_PROJECT" --arg it "$itype" --arg sum "$title" \
        --arg epic "$epic" --argjson desc "$(adf_doc "$body_desc")" --arg lbl "gh-issue-${gh_n#\#}" \
        '{fields:{project:{key:$proj},issuetype:{name:$it},summary:$sum,parent:{key:$epic},description:$desc,labels:[$lbl,"loop"]}}')"
    local key
    key="$(jira_curl POST /issue -d "$payload" | jq -r .key)"
    log "created JIRA $itype $key under epic $epic (mirrors #${gh_n#\#})"
    cmd_link --gh "$gh_n" --jira "$key"
    state_set jira "$key"
    echo "$key"
}

# ---------------------------------------------------------------------------
# mirror-subtask: create a JIRA Sub-task under a mirrored parent story,
# mirroring a GH sub-issue.
# ---------------------------------------------------------------------------
cmd_mirror_subtask() {
    require_gate 2
    parse_args "$@"
    local gh_n="${ARGS[gh]:?--gh required}" jparent="${ARGS["jira-parent"]:?--jira-parent required}"
    local existing
    existing="$(find_jira_by_gh "$gh_n")"
    if [ -n "$existing" ]; then
        log "JIRA already mirrors #${gh_n#\#}: $existing (no-op)"
        echo "$existing"
        return
    fi
    local title
    title="$(gh issue view "${gh_n#\#}" --repo "$GH_REPO" --json title -q .title)"
    local payload
    payload="$(jq -n --arg proj "$JIRA_PROJECT" --arg sum "$title" --arg parent "$jparent" \
        --argjson desc "$(adf_doc "Mirrors $(gh_issue_url "${gh_n#\#}")")" --arg lbl "gh-issue-${gh_n#\#}" \
        '{fields:{project:{key:$proj},issuetype:{name:"Sub-task"},summary:$sum,parent:{key:$parent},description:$desc,labels:[$lbl,"loop"]}}')"
    local key
    key="$(jira_curl POST /issue -d "$payload" | jq -r .key)"
    log "created JIRA Sub-task $key under $jparent (mirrors #${gh_n#\#})"
    cmd_link --gh "$gh_n" --jira "$key"
    echo "$key"
}

# ---------------------------------------------------------------------------
# link: idempotent bidirectional cross-link.
#   JIRA -> GH via a remote link (globalId keyed on the GH url, so re-linking
#           updates rather than duplicates).
#   GH  -> JIRA by ensuring a "JIRA: <KEY>" line + label in the issue body.
# ---------------------------------------------------------------------------
cmd_link() {
    require_gate 2
    parse_args "$@"
    local gh_n="${ARGS[gh]:?--gh required}" key="${ARGS[jira]:?--jira required}"
    local url
    url="$(gh_issue_url "${gh_n#\#}")"
    # JIRA remote link (globalId = url => upsert semantics).
    jira_curl POST "/issue/${key}/remotelink" -d "$(jq -n --arg u "$url" --arg k "$key" \
        '{globalId:$u, object:{url:$u, title:("GitHub issue: "+$u|sub("https://github.com/";""))}}')" >/dev/null
    # GH body marker (only add if absent).
    local body
    body="$(gh issue view "${gh_n#\#}" --repo "$GH_REPO" --json body -q .body)"
    if ! grep -q "JIRA: ${key}" <<<"$body"; then
        printf '%s\n\n---\nJIRA: %s (https://%s/browse/%s)\n' "$body" "$key" "$JIRA_SITE" "$key" |
            gh issue edit "${gh_n#\#}" --repo "$GH_REPO" --body-file - >/dev/null
    fi
    gh label create "jira:${key}" --color 0e8a16 --description "Mirrored JIRA issue" >/dev/null 2>&1 || true
    gh issue edit "${gh_n#\#}" --repo "$GH_REPO" --add-label "jira:${key}" >/dev/null 2>&1 || true
    log "linked #${gh_n#\#} <-> $key"
}

# ---------------------------------------------------------------------------
# status: transition a JIRA issue by target status NAME (resolves the id).
# --jira falls back to this branch's recorded state when omitted, so a
# resumed session does not need $JIRA held in memory across turns.
# ---------------------------------------------------------------------------
cmd_status() {
    parse_args "$@"
    local key="${ARGS[jira]:-$(state_read '.jira')}" to="${ARGS[to]:?--to required}"
    [ -n "$key" ] || die "--jira required (not given, and none recorded in state — pass --jira, or run sync mirror-jira/bootstrap first)"
    local tid
    tid="$(jira_curl GET "/issue/${key}/transitions" | jq -r --arg n "$to" '.transitions[] | select(.name==$n) | .id' | head -1)"
    [ -n "$tid" ] || die "no transition named '$to' available on $key (check workflow)"
    jira_curl POST "/issue/${key}/transitions" -d "$(jq -n --arg id "$tid" '{transition:{id:$id}}')" >/dev/null
    log "$key -> $to"
}

# ---------------------------------------------------------------------------
# auto-status: read the PR's actual state and pick the JIRA transition
# deterministically, instead of the loop skill remembering which PR event
# maps to which transition across many turns. No-ops on a closed-unmerged PR
# (never auto-revert a status). --jira and --pr both fall back to recorded
# state / the current branch's PR when omitted — the same reasoning as
# cmd_status.
# ---------------------------------------------------------------------------
cmd_auto_status() {
    parse_args "$@"
    local key="${ARGS[jira]:-$(state_read '.jira')}"
    [ -n "$key" ] || die "--jira required (not given, and none recorded in state — pass --jira, or run sync mirror-jira/bootstrap first)"
    local repo
    repo="$(gh_repo)"
    local pr="${ARGS[pr]:-}"
    [ -n "$pr" ] || pr="$(gh pr view --repo "$repo" --json number -q .number 2>/dev/null || true)"
    [ -n "$pr" ] || pr="$(state_read '.pr')"
    [ -n "$pr" ] || die "--pr required (not given, no open PR found for the current branch, and none recorded in state)"
    state_set pr "$pr"
    local state
    state="$(gh pr view "$pr" --repo "$repo" --json state -q .state)"
    case "$state" in
    OPEN) cmd_status --jira "$key" --to "In Progress" ;;
    MERGED) cmd_status --jira "$key" --to "Done" ;;
    CLOSED) log "PR #$pr closed unmerged — leaving $key status as-is (no auto-revert)" ;;
    *) die "unexpected PR state for #$pr: $state" ;;
    esac
}

# ---------------------------------------------------------------------------
# bootstrap: run the full GATE-2-approved sequence — create-issue, mirror-jira,
# then per --subitem: add-subissue + mirror-subtask — as ONE call instead of
# the agent threading $ISSUE/$JIRA through N sequential calls. Only call this
# AFTER GATE 2 approval: it performs exactly the mutating sequence GATE 2
# gates, just composed into one script. Each step is still the same
# idempotent primitive, so re-running bootstrap on a partially-created set
# no-ops the parts that already exist. Prints one JSON summary.
#
# Usage: bootstrap --title T --body-file F --epic SWONE-K [--type Story]
#                  [--subitem "<title>"]...
# ---------------------------------------------------------------------------
cmd_bootstrap() {
    local title="" body_file="" epic="" itype="Story"
    local -a subitems=()
    while [ $# -gt 0 ]; do
        case "$1" in
        --title)
            title="$2"
            shift 2
            ;;
        --body-file)
            body_file="$2"
            shift 2
            ;;
        --epic)
            epic="$2"
            shift 2
            ;;
        --type)
            itype="$2"
            shift 2
            ;;
        --subitem)
            subitems+=("$2")
            shift 2
            ;;
        *) die "bootstrap: unexpected arg: $1" ;;
        esac
    done
    [ -n "$title" ] || die "bootstrap: --title required"
    [ -n "$body_file" ] || die "bootstrap: --body-file required"
    [ -n "$epic" ] || die "bootstrap: --epic required"

    local issue jira
    issue="$(cmd_create_issue --title "$title" --body-file "$body_file")"
    jira="$(cmd_mirror_jira --gh "$issue" --epic "$epic" --type "$itype")"

    local subs_json="[]"
    for subtitle in "${subitems[@]:-}"; do
        [ -n "$subtitle" ] || continue
        local sub subjira
        sub="$(cmd_add_subissue --parent "$issue" --title "$subtitle")"
        subjira="$(cmd_mirror_subtask --gh "$sub" --jira-parent "$jira")"
        subs_json="$(jq -c --argjson arr "$subs_json" --arg gh "$sub" --arg jira "$subjira" '$arr + [{gh:$gh, jira:$jira}]' <<<'null')"
    done
    jq -n --arg issue "$issue" --arg jira "$jira" --argjson subs "$subs_json" \
        '{issue:$issue, jira:$jira, subissues:$subs}'
}

sub="${1:-}"
shift || true
case "$sub" in
create-issue) cmd_create_issue "$@" ;;
add-subissue) cmd_add_subissue "$@" ;;
mirror-jira) cmd_mirror_jira "$@" ;;
mirror-subtask) cmd_mirror_subtask "$@" ;;
link) cmd_link "$@" ;;
status) cmd_status "$@" ;;
auto-status) cmd_auto_status "$@" ;;
bootstrap) cmd_bootstrap "$@" ;;
verify) jira_verify ;;
*) die "usage: sync.sh {create-issue|add-subissue|mirror-jira|mirror-subtask|link|status|auto-status|bootstrap|verify} ..." ;;
esac
