#!/usr/bin/env bash
# status.sh — `loop where`: what does the run state say, and does live
# gh/JIRA/git evidence agree? Exists for two failure modes /loop kept
# hitting on long sessions: (1) a resumed or post-compaction session has no
# memory of which stage it was in, and (2) the ship-gate re-arm mistake —
# pushing again after a clear ship gate and treating the old pass as still
# covering the new commits. Read-only: makes no gh/JIRA/git mutations.
#
# Named "where", not "status", so it cannot be confused with the existing
# `sync status` (which transitions one JIRA ticket).
#
# Usage: status.sh [branch]
# Exit:  0 if state and live facts agree (or nothing is tracked yet).
#        1 if drift is found — see the "DRIFT" lines in the report.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_config

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
repo="$(gh_repo)"
drift=0

echo "===== loop where (branch: $branch) ====="

# --- gates -----------------------------------------------------------------
for n in 1 2; do
    approved="$(state_read ".gate${n}.approved" false "$branch")"
    if [ "$approved" = "true" ]; then
        note="$(state_read ".gate${n}.note" "" "$branch")"
        at="$(state_read ".gate${n}.at" "" "$branch")"
        if [ -n "$note" ]; then
            echo "gate $n: PASSED at $at ($note)"
        else
            echo "gate $n: PASSED at $at"
        fi
    else
        echo "gate $n: NOT recorded"
    fi
done

# --- tracked GH issue --------------------------------------------------------
issue="$(state_read '.issue' '' "$branch")"
if [ -n "$issue" ]; then
    live=""
    live="$(gh issue view "${issue#\#}" --repo "$repo" --json state,title 2>/dev/null)" || live=""
    if [ -n "$live" ]; then
        echo "issue: $issue ($(jq -r .state <<<"$live")) -- $(jq -r .title <<<"$live")"
    else
        echo "issue: $issue -- DRIFT: not found on GitHub (deleted, or wrong repo config?)"
        drift=1
    fi
else
    echo "issue: not tracked"
fi

# --- tracked JIRA key --------------------------------------------------------
jira="$(state_read '.jira' '' "$branch")"
if [ -n "$jira" ]; then
    body=""
    body="$(jira_curl GET "/issue/${jira}" -G --data-urlencode "fields=status" 2>/dev/null)" || body=""
    if [ -n "$body" ]; then
        echo "jira: $jira ($(jq -r '.fields.status.name // "unknown"' <<<"$body"))"
    else
        echo "jira: $jira -- DRIFT: not found in JIRA (deleted, or wrong key?)"
        drift=1
    fi
else
    echo "jira: not tracked"
fi

# --- PR: live vs. recorded ----------------------------------------------------
recorded_pr="$(state_read '.pr' '' "$branch")"
live_pr=""
live_pr="$(gh pr view "$branch" --repo "$repo" --json number,state,url 2>/dev/null)" || live_pr=""
if [ -n "$live_pr" ]; then
    live_n="$(jq -r .number <<<"$live_pr")"
    live_state="$(jq -r .state <<<"$live_pr")"
    live_url="$(jq -r .url <<<"$live_pr")"
    echo "pr: #$live_n ($live_state) $live_url"
    if [ -n "$recorded_pr" ] && [ "$recorded_pr" != "$live_n" ]; then
        echo "  DRIFT: state recorded pr #$recorded_pr, live PR for this branch is #$live_n"
        drift=1
    fi
elif [ -n "$recorded_pr" ]; then
    echo "pr: state recorded #$recorded_pr, but no live PR found for this branch -- DRIFT (closed and gh can't resolve it this way, or branch renamed?)"
    drift=1
else
    echo "pr: none open for this branch"
fi

# --- ship-gate freshness -------------------------------------------------------
last_pass="$(state_read '.lastShipGatePassCommit' '' "$branch")"
if [ -n "$last_pass" ]; then
    tip="$(git rev-parse "$branch" 2>/dev/null || true)"
    if [ "$tip" = "$last_pass" ]; then
        echo "ship-gate: clear as of $last_pass (current tip -- nothing pushed since)"
    else
        ahead="$(git rev-list --count "${last_pass}..${branch}" 2>/dev/null || echo '?')"
        echo "ship-gate: DRIFT -- $ahead commit(s) on $branch since the last clear pass ($last_pass). Re-run: loop ship-gate"
        drift=1
    fi
else
    echo "ship-gate: never recorded as clear on this branch"
fi

echo "==========================================="
if [ "$drift" -eq 0 ]; then
    log "no drift found"
else
    warn "drift found -- see the DRIFT lines above"
fi
exit "$drift"
