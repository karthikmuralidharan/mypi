#!/usr/bin/env bash
# replan.sh — revise the spec after coding has started.
#
# The problem this solves: after GATE 2 the issue body is the source of truth,
# but the feedback that invalidates it arrives later — in review, in CI, in a
# Copilot comment, or when a seam turns out not to exist as specified. Without
# a sanctioned path the choice is to let the issue quietly become a lie, or to
# `gh issue edit` outside the loop with no gate, no state record and no JIRA
# mirror.
#
# Who decides what:
#
#   The AGENT decides to ENTER replan. Cheap, immediate, needs evidence.
#   The HUMAN decides to LEAVE it. `apply` requires GATE 1 re-approved.
#
# That split matters. If the agent could both declare the spec wrong and
# ratify its replacement, the cheapest way to make failing work pass would be
# to rewrite the spec to match the code, and the issue would stop being a
# contract. Entry is free; exit is gated.
#
# Behaviours, spec and plan are revised together because they are coupled —
# changing the interfaces table without the behaviour criteria produces an
# internally inconsistent issue.
#
# Sub-issues are reconciled as a true revision: unchanged items stay (keeping
# their history and comments), new items are added, dropped items are CLOSED
# with the reason, never deleted.
#
# Usage:
#   replan.sh start --evidence TEXT [--section NAME]...
#   replan.sh apply --body-file F [--subitem TITLE]...
#   replan.sh status
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_config
require jq gh

SYNC="$HERE/sync.sh"

# ---------------------------------------------------------------------------
# start: open a revision. Records the evidence and un-approves GATE 1, so the
# plan is formally unapproved until a human re-approves it.
# ---------------------------------------------------------------------------
cmd_start() {
    local evidence="" sections=""
    while [ $# -gt 0 ]; do
        case "$1" in
        --evidence)
            evidence="$2"
            shift 2
            ;;
        --section)
            sections="${sections:+$sections,}$2"
            shift 2
            ;;
        *) die "replan start: unexpected arg: $1" ;;
        esac
    done
    [ -n "$evidence" ] || die "replan start: --evidence required — cite the
feedback that invalidated the spec (a review thread, a failing run, a tool
result). \"the implementation turned out awkward\" is a Stage 5 design
discussion, not a replan."

    local open rev
    open="$(state_read '.replan.open' false)"
    if [ "$open" = "true" ]; then
        log "replan already open (revision $(state_read '.revision' 0) -> $(($(state_read '.revision' 0) + 1)))"
        log "  evidence: $(state_read '.replan.evidence')"
        return 0
    fi
    rev="$(state_read '.revision' 0)"

    state_set_json replan "$(jq -n --arg e "$evidence" --arg s "$sections" \
        '{open:true, at:(now|todate), evidence:$e,
          sections:($s|if .=="" then [] else split(",") end)}')"
    # Re-arm GATE 1: the plan on the issue is no longer the approved plan.
    state_set_json gate1 "$(jq -n '{approved:false, at:(now|todate),
        note:"re-armed by replan — plan under revision"}')"

    log "replan OPEN — revision $rev -> $((rev + 1))"
    log "  evidence: $evidence"
    [ -n "$sections" ] && log "  sections: $sections"
    cat >&2 <<'EOF'
[loop] Next:
  1. Regenerate behaviour criteria + technical spec + plan together.
     See references/technical-spec.md for the five required sections.
  2. Take the revised plan back through plannotator for human approval.
  3. Record it:  loop gate-pass 1 --note "<what was approved>"
  4. Land it:    loop replan apply --body-file <file> [--subitem "..."]...
Do not resume Stage 5 coding while a replan is open — that is the drift this
mode exists to prevent.
EOF
}

# ---------------------------------------------------------------------------
# apply: land the revision. Gated on GATE 1 being re-approved AFTER start.
# Updates the body, reconciles sub-issues, comments on JIRA, bumps the
# revision counter and closes the replan. Idempotent.
# ---------------------------------------------------------------------------
cmd_apply() {
    local body_file=""
    local -a subitems=()
    while [ $# -gt 0 ]; do
        case "$1" in
        --body-file)
            body_file="$2"
            shift 2
            ;;
        --subitem)
            subitems+=("$2")
            shift 2
            ;;
        *) die "replan apply: unexpected arg: $1" ;;
        esac
    done
    [ -n "$body_file" ] || die "replan apply: --body-file required"
    [ -f "$body_file" ] || die "replan apply: body file not found: $body_file"

    [ "$(state_read '.replan.open' false)" = "true" ] ||
        die "no replan is open — run 'loop replan start --evidence ...' first"

    # The human-ratifies-exit rule. require_gate 1 fails while gate1 is the
    # un-approved record that `start` wrote.
    require_gate 1

    local issue
    issue="$(state_read '.issue')"
    [ -n "$issue" ] || die "no issue recorded in state — nothing to revise"

    log "applying revision to $issue"
    "$SYNC" update-issue --gh "$issue" --body-file "$body_file" >/dev/null

    # --- reconcile sub-issues against the revised plan ---------------------
    local existing
    existing="$("$SYNC" list-subissues --parent "$issue")"
    local kept=0 added=0 closed=0
    local -a want=("${subitems[@]:-}")

    # Build the wanted-title set one element at a time: `jq --args` has awkward
    # edge cases with an empty array and with a single empty string.
    local titles_json='[]'
    local t
    for t in "${want[@]:-}"; do
        [ -n "$t" ] || continue
        titles_json="$(jq -c --arg t "$t" '. + [$t]' <<<"$titles_json")"
    done

    # close anything open that the revised plan no longer contains
    local n
    while IFS=$'\t' read -r n t; do
        [ -n "$n" ] || continue
        if jq -e --arg t "$t" 'index($t)' <<<"$titles_json" >/dev/null; then
            kept=$((kept + 1))
        else
            "$SYNC" close-subissue --gh "$n" \
                --reason "$(state_read '.replan.evidence')" >/dev/null
            closed=$((closed + 1))
        fi
    done < <(jq -r '.[] | select(.state=="OPEN") | "\(.number)\t\(.title)"' <<<"$existing")

    # add anything the revised plan introduces
    local jira
    jira="$(state_read '.jira')"
    for t in "${want[@]:-}"; do
        [ -n "$t" ] || continue
        if jq -e --arg t "$t" '.[] | select(.title==$t)' <<<"$existing" >/dev/null; then
            continue
        fi
        local sub
        sub="$("$SYNC" add-subissue --parent "$issue" --title "$t")"
        [ -n "$jira" ] && "$SYNC" mirror-subtask --gh "$sub" --jira-parent "$jira" >/dev/null
        added=$((added + 1))
    done

    # --- record and close out ---------------------------------------------
    local rev
    rev=$(($(state_read '.revision' 0) + 1))
    state_set revision "$rev"
    state_set_json replan "$(jq -n --arg e "$(state_read '.replan.evidence')" --arg r "$rev" \
        '{open:false, applied_at:(now|todate), evidence:$e, revision:($r|tonumber)}')"

    if [ -n "$jira" ]; then
        # JIRA_API already contains /rest/api/3, so the path is relative to it.
        jira_curl POST "/issue/${jira}/comment" \
            -d "$(jq -n --argjson body "$(adf_doc "Spec revision ${rev} applied to $(gh_issue_url_safe "$issue"). Reason: $(state_read '.replan.evidence')")" '{body:$body}')" \
            >/dev/null || warn "could not comment on $jira"
    fi

    # A revision invalidates any clear ship gate. The gate records the commit
    # it passed against so `where` can tell "still on the passing commit" from
    # "pushed since"; a spec revision means that pass was earned against a
    # contract that no longer holds, so drop it and make the gate be re-earned.
    state_set lastShipGatePassCommit ""

    log "revision $rev applied — sub-issues: $kept kept, $added added, $closed closed"
    log "ship gate re-armed — it must clear again before shipping"
    cat >&2 <<'EOF'
[loop] After reworking the code to the revised plan:
  1. Re-earn the ship gate:  loop ship-gate
  2. Then get an INDEPENDENT review with fresh context, so the reviewer
     judges the code against the revised spec without having argued itself
     into the design:

       subagent(agent: "reviewer", context: "fresh",
                task: "Read the spec and plan in GH issue <issue>, then review
                       the diff on this branch against it. This spec was
                       revised (revision <n>) because: <evidence>. Report
                       whether the code now matches the revised contract, and
                       flag anything the revision missed. Read-only: do not
                       edit files.")

     Fresh context is the point. A reviewer that carried this session's
     history would inherit the same assumptions that produced the spec which
     had to be revised.
  3. Synthesize the findings here and fix them in this session.
EOF
    jq -n --arg issue "$issue" --arg jira "$jira" --argjson rev "$rev" \
        --argjson kept "$kept" --argjson added "$added" --argjson closed "$closed" \
        '{issue:$issue, jira:$jira, revision:$rev, shipGateRearmed:true,
          subissues:{kept:$kept, added:$added, closed:$closed}}'
}

cmd_status() {
    local open rev
    open="$(state_read '.replan.open' false)"
    rev="$(state_read '.revision' 0)"
    if [ "$open" = "true" ]; then
        printf 'replan: OPEN (revision %s -> %s)\n' "$rev" "$((rev + 1))"
        printf '  evidence : %s\n' "$(state_read '.replan.evidence')"
        printf '  gate 1   : %s\n' "$(state_read '.gate1.approved' false)"
        printf '  blocking : do not resume Stage 5 coding\n'
        return 1
    fi
    printf 'replan: closed (at revision %s)\n' "$rev"
    if [ "$rev" != "0" ] && [ -z "$(state_read '.lastShipGatePassCommit')" ]; then
        printf '  ship gate: re-armed by revision %s — not yet re-earned\n' "$rev"
        return 1
    fi
}

gh_issue_url_safe() { printf 'https://github.com/%s/issues/%s' "$(gh_repo)" "${1#\#}"; }

sub="${1:-}"
shift || true
case "$sub" in
start) cmd_start "$@" ;;
apply) cmd_apply "$@" ;;
status) cmd_status "$@" ;;
*) die "usage: replan.sh {start --evidence TEXT [--section N]... | apply --body-file F [--subitem T]... | status}" ;;
esac
