#!/usr/bin/env bash
# Show the current run. A recorded pass is history until live checks agree.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=lib/readiness.sh
source "$HERE/lib/readiness.sh"
require_config

branch="${1:-$(git branch --show-current)}"
echo "===== loop where (branch: $branch) ====="
if ! state_file "$branch" >/dev/null; then
    echo "No active loop run. Use loop start to begin."
    exit 0
fi
echo "run: $(branch_run "$branch")"
repo="$(gh_repo)"
drift=0

report_gate() {
    local gate="$1" note time
    note="$(state_read ".gate$gate.note" '' "$branch")"
    time="$(state_read ".gate$gate.at" '' "$branch")"
    printf 'gate %s: PASSED at %s%s\n' "$gate" "$time" "${note:+ ($note)}"
}

hash=""
scope=""
if [ "$(state_read '.gate1.approved' false "$branch")" != true ]; then
    echo "gate 1: not recorded"
elif hash="$(approved_spec_hash "$branch" 2>/dev/null)"; then
    report_gate 1
    echo "approved spec: $(state_read '.gate1.specFile' '' "$branch") ($hash)"
else
    echo "gate 1: STALE -- approved spec changed or is missing"
    drift=1
fi
if [ "$(state_read '.gate2.approved' false "$branch")" != true ]; then
    echo "gate 2: not recorded"
elif scope="$(approved_ticket_scope "$branch" 2>/dev/null)"; then
    report_gate 2
else
    echo "gate 2: STALE -- approved spec, repository, or Jira config differs"
    drift=1
fi

issue="$(state_read '.issue' '' "$branch")"
jira="$(state_read '.jira' '' "$branch")"
if [ -z "$issue" ]; then
    echo "issue: not tracked"
elif ! github="$(gh issue view "${issue#\#}" --repo "$repo" --json number,state,title,body 2>/dev/null)"; then
    echo "issue: $issue -- UNAVAILABLE: could not read from GitHub"
    drift=1
elif [ -n "$scope" ] && ! approved_parent "$scope" "$hash" "$issue" "$branch" "$github" >/dev/null 2>&1; then
    echo "issue: $issue -- DRIFT: approved issue title or body differs"
    drift=1
else
    echo "issue: $issue ($(jq -r '.state' <<<"$github")) -- $(jq -r '.title' <<<"$github")"
fi
if [ -z "$jira" ]; then
    echo "jira: not tracked"
elif ! jira_data="$(jira_issue_snapshot "$jira" 2>/dev/null)"; then
    echo "jira: $jira -- UNAVAILABLE: could not read Jira issue"
    drift=1
elif [ -n "$scope" ] && ! jira_mirror_matches "$repo" "${issue#\#}" "$(jq -r '.epic' <<<"$scope")" Story "$jira_data"; then
    echo "jira: $jira -- DRIFT: mirror no longer belongs to the approved issue and epic"
    drift=1
else
    echo "jira: $jira ($(jq -r '.fields.status.name // "unknown"' <<<"$jira_data"))"
fi

binding="$(state_read '.prBinding' '' "$branch")"
live_pr=""
current_run=""
if [ "$drift" -eq 0 ] && [ -n "$scope" ] && [ -n "$issue" ] && [ -n "$jira" ]; then
    current_run="$(run_fingerprint "$branch" "$scope" "$hash" "${issue#\#}" "$jira")"
fi
if [ -z "$binding" ]; then
    echo "pr: not bound"
elif [ -z "$current_run" ] || [ "$(jq -r '.run' <<<"$binding")" != "$current_run" ]; then
    echo "pr: STALE -- bind the PR for the current approval"
    drift=1
else
    recorded_pr="$(jq -er '.number' <<<"$binding")"
    if ! live_pr="$(pr_snapshot "$repo" "$recorded_pr" 2>/dev/null)"; then
        echo "pr: #$recorded_pr -- UNAVAILABLE: could not read from GitHub"
        live_pr=""
        drift=1
    elif ! pr_binding_matches "$binding" "$branch" "$jira" "$live_pr"; then
        echo "pr: #$recorded_pr -- DRIFT: current repository, base, branch, or issue differs from the binding"
        drift=1
    else
        echo "pr: #$recorded_pr ($(jq -r '.state' <<<"$live_pr")) $(jq -r '.url' <<<"$live_pr")"
    fi
fi

policy="$(state_read '.shipPass' '' "$branch")"
if [ -z "$policy" ]; then
    echo "ship-gate: no recorded pass"
else
    last_pass="$(jq -r '.head // empty' <<<"$policy")"
    echo "ship-gate: last passed at $last_pass"
    if [ "$drift" -ne 0 ] || [ -z "$binding" ] || [ -z "$live_pr" ] ||
        [ "$(jq -r '.run // empty' <<<"$policy")" != "$current_run" ] ||
        ! jq -e --argjson binding "$binding" '.binding == $binding' <<<"$policy" >/dev/null; then
        echo "ship-gate: DRIFT -- approval, ticket, or PR binding differs from the recorded pass"
        drift=1
    elif [ "$(jq -r '.state' <<<"$live_pr")" = MERGED ]; then
        echo "ship-gate: PR merged"
    elif pr_ready_now "$branch" "$jira" "$binding" "$policy" "$live_pr"; then
        echo "ship-gate: ready at $last_pass (live GitHub policy and recorded evidence checked)"
    else
        echo "ship-gate: DRIFT -- live checks or commit evidence differ from the recorded pass"
        drift=1
    fi
fi

exit "$drift"
