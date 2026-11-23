#!/usr/bin/env bash
# Sync the approved GitHub issue and Jira hierarchy.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_config
[ "${BASH_VERSINFO[0]}" -ge 4 ] || die "sync requires Bash 4 or later"

sub="${1:-}"
shift || true
case "$sub" in
    create-issue | update-issue | add-subissue | mirror-jira | mirror-subtask | link | bind-pr | status | auto-status | clear-unconfirmed)
        if [ -z "${LOOP_WRITE_LOCK:-}" ]; then
            exec python3 "$HERE/lib/with-lock.py" "$HERE/sync.sh" "$sub" "$@"
        fi ;;
    list-subissues | review-issue | verify) ;;
    *) die "unknown sync subcommand: $sub" ;;
esac

GH_REPO="$(gh_repo)"
declare -A ARGS
while [ "$#" -gt 0 ]; do
    case "$1" in
        --*) [ "$#" -ge 2 ] || die "missing value for $1"; ARGS["${1#--}"]="$2"; shift 2 ;;
        *) die "unexpected argument: $1" ;;
    esac
done

draft_copy=""
trap '[ -z "$draft_copy" ] || rm -f "$draft_copy"' EXIT

github_issue() {
    [[ "$1" =~ ^[1-9][0-9]*$ ]] || die "invalid GitHub issue number: $1"
    gh issue view "$1" --repo "$GH_REPO" --json title,body,number
}

child_issues() {
    [[ "$1" =~ ^[1-9][0-9]*$ ]] || die "invalid GitHub parent issue number: $1"
    gh api --paginate --slurp "repos/$GH_REPO/issues/$1/sub_issues" |
        jq -ec '[.[][] | {number, title, state: (.state | ascii_upcase)}]'
}

require_parent() {
    approved_parent "$scope" "$spec_hash" "$(state_read '.issue')"
}

approved_child() {
    jq -ce --arg title "$1" '.subissues[] | select(.title == $title)' <<<"$scope" ||
        die "sub-issue title is outside the approved scope: $1"
}

validate_child_identity() {
    local parent="$1" number="$2" title="$3" approval existing data marker
    approval="$(approved_child "$title")"
    existing="$(jq -r '.issue // empty' <<<"$approval")"
    data="$(github_issue "$number")"
    jq -e --arg title "$title" --arg number "$number" \
        '.title == $title and (.number | tostring) == $number' <<<"$data" >/dev/null ||
        die "issue #$number does not have the approved identity"
    if [ -n "$existing" ]; then
        [ "$number" = "$existing" ] || die "issue #$number is not the approved existing child #$existing"
    else
        marker="<!-- loop-operation:$(operation_id child "$parent" "$title") -->"
        jq -e --arg marker "$marker" '((.body // "") | split("\n") | index($marker)) != null' \
            <<<"$data" >/dev/null || die "issue #$number is not the result of the approved child create"
    fi
}

require_child() {
    local parent="$1" number="$2" title
    title="$(child_issues "$parent" | jq -er --arg number "$number" '
        .[] | select((.number | tostring) == $number) | .title
    ')" || die "GitHub issue #$number is not attached to the tracked parent"
    validate_child_identity "$parent" "$number" "$title"
}

snapshot_spec() {
    local file="$1"
    [ -f "$file" ] || die "spec file not found: $file"
    draft_copy="$(mktemp "${TMPDIR:-/tmp}/loop-spec.XXXXXX")"
    cat -- "$file" >"$draft_copy"
    [ "$(git hash-object --no-filters -- "$draft_copy")" = "$spec_hash" ] ||
        die "the body differs from the approved spec"
}

operation_id() {
    printf '%s\n' "$GH_REPO" "$@" | git hash-object --stdin
}

# Persist intent before a request. After a transport failure, a retry may
# reconcile an existing remote record but must not send a second create.
begin_create() {
    local journal="$LOOP_WRITE_LOCK/op-$1"
    [ ! -e "$journal" ] ||
        die "create $1 is unresolved; inspect the remote system before retrying"
    printf 'pending\n' >"$journal"
}

record_created() {
    local journal="$LOOP_WRITE_LOCK/op-$1"
    printf '%s\n' "$2" >"$journal.tmp"
    mv "$journal.tmp" "$journal"
}

known_create() {
    local journal="$LOOP_WRITE_LOCK/op-$1"
    [ -f "$journal" ] || return 0
    grep -vFx pending "$journal" || true
}

find_github_create() {
    gh api --paginate --slurp -X GET "repos/$GH_REPO/issues" -f state=all -f per_page=100 |
        jq -r --arg marker "<!-- loop-operation:$1 -->" '
            [.[][] | select(.pull_request == null) |
                select(((.body // "") | split("\n") | index($marker)) != null) | .number] |
            if length > 1 then error("multiple issues match the operation") else .[0] // empty end
        '
}

create_github_issue() {
    local id="$1" title="$2" file="$3" number url
    begin_create "$id"
    url="$(gh issue create --repo "$GH_REPO" --title "$title" --body-file "$file")"
    number="${url##*/}"
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || die "GitHub did not return an issue number for $id"
    record_created "$id" "$number"
    printf '%s\n' "$number"
}

cmd_create_issue() {
    local title="${ARGS[title]:?--title required}" file="${ARGS[body-file]:?--body-file required}"
    [ "$(jq -r '.issue' <<<"$scope")" = null ] && [ "$title" = "$approved_title" ] ||
        die "GitHub issue creation is outside the approved scope"
    [ -z "${ARGS[label]:-}" ] || die "ticket approval does not include labels"
    snapshot_spec "$file"

    local id number tracked
    id="$(parent_creation_id "$scope" "$spec_hash")"
    tracked="$(state_read '.issue')"
    tracked="${tracked#\#}"
    number="$(known_create "$id")"
    if [ -n "${ARGS[known]:-}" ]; then
        [ -z "$number" ] || [ "$number" = "${ARGS[known]}" ] || die "the known issue differs from the recorded issue"
        number="${ARGS[known]}"
    fi
    [ -n "$number" ] || number="$(find_github_create "$id")"
    [ -z "$tracked" ] || [ "$number" = "$tracked" ] ||
        die "this branch already tracks #$tracked"
    if [ -z "$number" ]; then
        printf '\n\n<!-- loop-operation:%s -->\n' "$id" >>"$draft_copy"
        number="$(create_github_issue "$id" "$title" "$draft_copy")"
    fi
    approved_parent "$scope" "$spec_hash" "$number" >/dev/null
    record_created "$id" "$number"
    state_set issue "#$number"
    printf '#%s\n' "$number"
}

cmd_update_issue() {
    local number="${ARGS[gh]:-$(state_read '.issue')}" file="${ARGS[body-file]:?--body-file required}"
    local tracked live
    number="${number#\#}"
    tracked="$(state_read '.issue')"
    [ -z "$tracked" ] || [ "${tracked#\#}" = "$number" ] || die "this branch already tracks $tracked"
    jq -e --arg number "$number" '.issue != null and (.issue | tostring) == $number' <<<"$scope" >/dev/null ||
        die "issue #$number is outside the approved scope"
    snapshot_spec "$file"
    live="$(github_issue "$number")"
    [ "$(jq -er '.title' <<<"$live")" = "$approved_title" ] || die "the GitHub title differs from the approved title"
    local jira marker=""
    jira="$(state_read '.jira')"
    if [ -n "$jira" ]; then
        jira_mirror "$GH_REPO" "$jira" "$number" "$approved_epic" Story >/dev/null
        marker="$(jira_link_line "$jira")"
    fi
    if ! github_body_matches "$live" "$draft_copy" "" "$marker"; then
        # Read again immediately before the write. The Issues API provides no
        # atomic compare-and-swap for a body edit.
        live="$(github_issue "$number")"
        [ "$(jq -er '.title' <<<"$live")" = "$approved_title" ] &&
            [ "$(github_body_hash "$live")" = "$(jq -er .baseBodyHash <<<"$scope")" ] ||
            die "issue #$number changed since review; review its current body before updating"
        gh issue edit "$number" --repo "$GH_REPO" --body-file "$draft_copy" >/dev/null
    fi
    state_set issue "#$number"
    printf '#%s\n' "$number"
}

cmd_add_subissue() {
    local parent="${ARGS[parent]:?--parent required}" title="${ARGS[title]:?--title required}"
    local explicit="${ARGS[existing]:-${ARGS[known]:-}}" approval approved_id number attached id pid cid
    parent="${parent#\#}"
    explicit="${explicit#\#}"
    [ "$parent" = "$(require_parent)" ] || die "sub-issue parent differs from the tracked issue"
    approval="$(approved_child "$title")"
    approved_id="$(jq -r '.issue // empty' <<<"$approval")"
    [ -z "${ARGS[body-file]:-}" ] || [ ! -s "${ARGS[body-file]}" ] ||
        die "ticket approval covers the sub-issue title"
    id="$(operation_id child "$parent" "$title")"
    attached="$(child_issues "$parent" | jq -r --arg title "$title" '
        [.[] | select(.title == $title) | .number] |
        if length > 1 then error("multiple children have the approved title") else .[0] // empty end
    ')"
    number="$approved_id"
    [ -n "$number" ] || number="$(known_create "$id")"
    [ -n "$number" ] || [ -n "$explicit" ] || number="$(find_github_create "$id")"
    if [ -n "$attached" ]; then
        [ -z "$number" ] || [ "$number" = "$attached" ] || die "a different issue with this title is already attached"
        number="$attached"
    fi
    if [ -n "$explicit" ]; then
        [ -z "$number" ] || [ "$number" = "$explicit" ] || die "the existing issue differs from the identified issue"
        number="$explicit"
    fi
    if [ -z "$number" ]; then
        draft_copy="$(mktemp "${TMPDIR:-/tmp}/loop-child.XXXXXX")"
        printf '<!-- loop-operation:%s -->\n' "$id" >"$draft_copy"
        number="$(create_github_issue "$id" "$title" "$draft_copy")"
    fi
    validate_child_identity "$parent" "$number" "$title"
    [ -n "$approved_id" ] || record_created "$id" "$number"
    if [ -z "$attached" ]; then
        pid="$(gh api "repos/$GH_REPO/issues/$parent" -q .node_id)"
        cid="$(gh api "repos/$GH_REPO/issues/$number" -q .node_id)"
        gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}' \
            -f p="$pid" -f c="$cid" >/dev/null
    fi
    printf '#%s\n' "$number"
}

find_jira_mirror() {
    local number="$1" page token="" found='[]'
    local -a args
    while :; do
        args=(-G --data-urlencode "jql=project = $JIRA_PROJECT AND labels = gh-issue-$number"
                 --data-urlencode "fields=description,parent,project")
        [ -z "$token" ] || args+=(--data-urlencode "nextPageToken=$token")
        page="$(jira_curl GET /search/jql "${args[@]}")"
        found="$(jq -ce --argjson found "$found" --arg url "$(github_issue_url "$GH_REPO" "$number")" \
            '$found + [.issues[] | select('"$jira_has_github_url"') | .key]' <<<"$page")"
        token="$(jq -r '.nextPageToken // empty' <<<"$page")"
        [ -n "$token" ] || break
    done
    jq -r 'unique | if length > 1 then error("multiple Jira mirrors match this GitHub issue") else .[0] // empty end' <<<"$found"
}

link_issues() {
    local number="$1" key="$2" url marker body comment id existing
    url="$(github_issue_url "$GH_REPO" "$number")"
    marker="$(jira_link_line "$key")"
    body="$(github_issue "$number" | jq -r '.body // ""')"
    if ! grep -Fxq -- "$marker" <<<"$body"; then
        if grep -q '^JIRA: ' <<<"$body"; then
            die "GitHub issue #$number already has a different Jira link"
        fi
        id="$(operation_id jira-link "$number" "$key")"
        comment="$(printf '%s\n\n<!-- loop-operation:%s -->' "$marker" "$id")"
        existing="$(gh api --paginate --slurp "repos/$GH_REPO/issues/$number/comments" |
            jq -r --arg body "$comment" 'first(.[][] | select(.body == $body) | .id) // empty')"
        if [ -z "$existing" ]; then
            begin_create "$id"
            existing="$(gh api -X POST "repos/$GH_REPO/issues/$number/comments" -f body="$comment" | jq -er '.id')"
        fi
        record_created "$id" "$existing"
    fi
    # Jira treats globalId as the identity for remote-link upserts.
    jira_curl POST "/issue/$key/remotelink" -d "$(jq -n --arg url "$url" \
        '{globalId:$url,object:{url:$url,title:$url}}')" >/dev/null
}

mirror_issue() {
    local number="$1" parent="$2" type="$3" title id key recorded payload description explicit="${ARGS[known]:-}"
    id="$(operation_id jira "$JIRA_SITE" "$JIRA_PROJECT" "$number")"
    key="$(known_create "$id")"
    if [ "$parent" = "$approved_epic" ]; then
        recorded="$(state_read '.jira')"
        if [ -n "$recorded" ]; then
            [ -z "$key" ] || [ "$key" = "$recorded" ] || die "the recorded Jira story differs from the operation"
            key="$recorded"
        fi
    fi
    if [ -n "$explicit" ]; then
        [ -z "$key" ] || [ "$key" = "$explicit" ] || die "the known Jira issue differs from the recorded issue"
        key="$explicit"
    fi
    [ -n "$key" ] || key="$(find_jira_mirror "$number")"
    if [ -z "$key" ]; then
        title="$(github_issue "$number" | jq -er '.title')"
        description="$(adf_doc "Mirrors GitHub issue $(github_issue_url "$GH_REPO" "$number")")"
        payload="$(jq -n --arg project "$JIRA_PROJECT" --arg parent "$parent" --arg title "$title" \
            --arg type "$type" --arg label "gh-issue-$number" --argjson desc "$description" \
            '{fields:{project:{key:$project},issuetype:{name:$type},summary:$title,parent:{key:$parent},
                      description:$desc,labels:[$label,"loop"]}}')"
        begin_create "$id"
        key="$(jira_curl POST /issue -d "$payload" | jq -er '.key')"
        [[ "$key" =~ ^[A-Z][A-Z0-9_]*-[0-9]+$ ]] || die "Jira did not return an issue key for $id"
        record_created "$id" "$key"
    fi
    jira_mirror "$GH_REPO" "$key" "$number" "$parent" "$type" >/dev/null
    record_created "$id" "$key"
    if [ "$parent" = "$approved_epic" ]; then
        state_set jira "$key"
    fi
    link_issues "$number" "$key"
    printf '%s\n' "$key"
}

cmd_mirror_jira() {
    local number="${ARGS[gh]:?--gh required}" epic="${ARGS[epic]:?--epic required}"
    number="${number#\#}"
    [ "$number" = "$(require_parent)" ] && [ "$epic" = "$approved_epic" ] ||
        die "GitHub issue or Jira epic differs from the approved scope"
    [ "${ARGS[type]:-Story}" = Story ] || die "ticket approval covers a Jira Story"
    "$HERE/find-epic.sh" --key "$epic" >/dev/null
    mirror_issue "$number" "$epic" Story
}

cmd_mirror_subtask() {
    local number="${ARGS[gh]:?--gh required}" parent="${ARGS[jira-parent]:?--jira-parent required}"
    local github_parent tracked_jira
    number="${number#\#}"
    github_parent="$(require_parent)"
    tracked_jira="$(require_jira_ticket "$(git branch --show-current)")"
    [ "$parent" = "$tracked_jira" ] || die "Jira parent differs from the tracked story"
    jira_mirror "$GH_REPO" "$parent" "$github_parent" "$approved_epic" Story >/dev/null
    require_child "$github_parent" "$number"
    mirror_issue "$number" "$parent" Sub-task
}

cmd_link() {
    local number="${ARGS[gh]:?--gh required}" key="${ARGS[jira]:?--jira required}"
    local github_parent jira_parent
    number="${number#\#}"
    github_parent="$(require_parent)"
    jira_parent="$(require_jira_ticket "$(git branch --show-current)")"
    if [ "$number" = "$github_parent" ]; then
        [ "$key" = "$jira_parent" ] || die "Jira key differs from the tracked story"
        jira_mirror "$GH_REPO" "$key" "$number" "$approved_epic" Story >/dev/null
    else
        require_child "$github_parent" "$number"
        jira_mirror "$GH_REPO" "$jira_parent" "$github_parent" "$approved_epic" Story >/dev/null
        jira_mirror "$GH_REPO" "$key" "$number" "$jira_parent" Sub-task >/dev/null
    fi
    link_issues "$number" "$key"
}

transition_jira() {
    local key="$1" current="$2" to="$3" id
    [ "$current" != "$to" ] || return 0
    id="$(jira_curl GET "/issue/$key/transitions" |
        jq -r --arg name "$to" '[.transitions[] | select(.to.name == $name) | .id] | first // empty')"
    [ -n "$id" ] || die "no transition to '$to' available on $key"
    jira_curl POST "/issue/$key/transitions" -d "$(jq -n --arg id "$id" '{transition:{id:$id}}')" >/dev/null
    log "$key -> $to"
}

cmd_status() {
    local branch number key issue current
    branch="$(git branch --show-current)"
    number="$(require_parent)"
    key="$(require_jira_ticket "$branch")"
    [ "${ARGS[jira]:-$key}" = "$key" ] || die "Jira key differs from the tracked story"
    issue="$(jira_mirror "$GH_REPO" "$key" "$number" "$approved_epic" Story)"
    current="$(jq -er '.fields.status.name' <<<"$issue")"
    [ "${ARGS[to]:-}" != Done ] || die "use sync auto-status after the bound PR merges to mark the story Done"
    transition_jira "$key" "$current" "${ARGS[to]:?--to required}"
}

cmd_bind_pr() {
    local pr="${ARGS[pr]:?--pr required}" base="${ARGS[base]:?--base required}"
    local head_repo="${ARGS[head-repo]:-$GH_REPO}" mode="${ARGS[mode]:-full}"
    local branch run issue ticket data binding old old_state
    [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "use the numeric PR number"
    [[ "$head_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "use owner/repo for --head-repo"
    git check-ref-format "refs/heads/$base" || die "invalid base branch"
    case "$mode" in full | partial) ;; *) die "use full or partial for --mode" ;; esac
    branch="$(git branch --show-current)"
    run="$(run_identity "$branch")"
    issue="$(require_parent)"
    ticket="$(require_jira_ticket "$branch")"
    data="$(pr_snapshot "$GH_REPO" "$pr")"
    binding="$(jq -nc --arg repo "$GH_REPO" --arg headRepo "$head_repo" --arg number "$pr" --arg base "$base" \
        --arg mode "$mode" --arg issue "$issue" --arg run "$run" '{repo:$repo, headRepo:$headRepo, number:$number,
        base:$base, mode:$mode, issue:$issue, run:$run}')"
    pr_binding_matches "$binding" "$branch" "$ticket" "$data" ||
        die "the PR does not match the intended branch, repository, base, and issue scope"
    jq -e --arg head "$(git rev-parse HEAD)" '.state == "OPEN" and .headRefOid == $head' \
        <<<"$data" >/dev/null || die "bind an open PR for the current local commit"
    old="$(state_read '.prBinding' '' "$branch")"
    if [ -n "$old" ] && [ "$(jq -r '.number' <<<"$old")" != "$pr" ]; then
        old_state="$(pr_snapshot "$GH_REPO" "$(jq -r '.number' <<<"$old")" | jq -er '.state')"
        if [ "$old_state" != CLOSED ] && { [ "$old_state" != MERGED ] || [ "$(jq -r '.mode' <<<"$old")" != partial ]; }; then
            die "the run already tracks a PR; start a new run or close the previous PR first"
        fi
    elif [ -n "$old" ]; then
        jq -e --argjson new "$binding" 'del(.run) == ($new | del(.run))' <<<"$old" >/dev/null ||
            die "this PR is bound to a different repository, base, mode, or issue"
    fi
    state_set_json prBinding "$binding" "$branch"
    state_set pr "$pr" "$branch"
    log "bound PR #$pr to GitHub issue #$issue ($mode)"
}

cmd_auto_status() {
    local branch number key binding data mode issue current pr state
    branch="$(git branch --show-current)"
    number="$(require_parent)"
    key="$(require_jira_ticket "$branch")"
    [ "${ARGS[jira]:-$key}" = "$key" ] || die "Jira key differs from the tracked story"
    binding="$(require_pr_binding "$branch" "$(run_identity "$branch")")"
    pr="$(jq -er '.number' <<<"$binding")"
    [ "${ARGS[pr]:-$pr}" = "$pr" ] || die "PR number differs from the bound PR #$pr"
    data="$(pr_snapshot "$GH_REPO" "$pr")"
    pr_binding_matches "$binding" "$branch" "$key" "$data" || die "PR identity or issue linkage differs from the binding"
    mode="$(jq -er '.mode' <<<"$binding")"
    issue="$(jira_mirror "$GH_REPO" "$key" "$number" "$approved_epic" Story)"
    current="$(jq -er '.fields.status.name' <<<"$issue")"
    state="$(jq -er '.state' <<<"$data")"
    case "$state/$mode" in
        OPEN/*) transition_jira "$key" "$current" "In Progress" ;;
        MERGED/full) transition_jira "$key" "$current" "Done" ;;
        MERGED/partial | CLOSED/*) log "PR #$pr leaves $key at $current" ;;
        *) die "unexpected state for PR #$pr: $state" ;;
    esac
}

case "$sub" in
    review-issue)
        number="${ARGS[gh]:?--gh required}"
        data="$(github_issue "${number#\#}")"
        jq --arg hash "$(github_body_hash "$data")" '. + {baseBodyHash:$hash}' <<<"$data"
        exit ;;
    list-subissues)
        parent="${ARGS[parent]:-$(state_read '.issue')}"
        child_issues "${parent#\#}"
        exit ;;
    verify) jira_verify; exit ;;
    clear-unconfirmed)
        id="${ARGS[operation]:?--operation required}"
        [[ "$id" =~ ^[a-f0-9]{40,64}$ ]] || die "invalid operation ID"
        journal="$LOOP_WRITE_LOCK/op-$id"
        [ -f "$journal" ] && [ "$(cat "$journal")" = pending ] || die "operation is not pending"
        rm "$journal"
        log "cleared pending create $id"
        exit ;;
esac

scope="$(approved_ticket_scope)"
approved_title="$(jq -er '.title' <<<"$scope")"
approved_epic="$(jq -er '.epic' <<<"$scope")"
spec_hash="$(state_read '.gate2.specHash')"
case "$sub" in
    create-issue) cmd_create_issue ;;
    update-issue) cmd_update_issue ;;
    add-subissue) cmd_add_subissue ;;
    mirror-jira) cmd_mirror_jira ;;
    mirror-subtask) cmd_mirror_subtask ;;
    link) cmd_link ;;
    bind-pr) cmd_bind_pr ;;
    status) cmd_status ;;
    auto-status) cmd_auto_status ;;
esac
