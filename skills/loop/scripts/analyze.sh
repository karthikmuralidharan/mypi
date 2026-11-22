#!/usr/bin/env bash
# analyze.sh — consistency check across the spec, the plan and the live
# sub-issues. Reports; never edits.
#
# This is the mechanical form of the GATE 1 self-check in
# references/technical-spec.md. Spec Kit's `analyze` is the same idea: it
# reports inconsistencies across spec/plan/tasks without touching files, so
# the agent cannot "fix" a finding by quietly rewriting intent.
#
# Reads a local draft before approval, or the live issue and children after linking.
#
# Usage: analyze.sh [--body-file <file> | --gh <n>] [--require-plan-evidence] [--json]
# Exit:  0 all checks pass, 1 one or more findings, 2 could not run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
issue=""
body_file=""
as_json=0
require_plan_evidence=false
while [ $# -gt 0 ]; do
    case "$1" in
    --gh)
        issue="$2"
        shift 2
        ;;
    --body-file)
        body_file="${2:?--body-file requires a path}"
        shift 2
        ;;
    --json)
        as_json=1
        shift
        ;;
    --require-plan-evidence)
        require_plan_evidence=true
        shift
        ;;
    *) die "analyze: unexpected arg: $1" ;;
    esac
done
if [ -n "$body_file" ]; then
    [ -z "$issue" ] || die "use either --body-file or --gh"
    [ -f "$body_file" ] || die "body file not found: $body_file"
    body="$(cat "$body_file")"
    source="$body_file"
else
    require_config
    GH_REPO="$(gh_repo)"
    [ -n "$issue" ] || issue="$(state_read '.issue')"
    [ -n "$issue" ] || die "no issue to analyze (pass --gh <n> or --body-file <file>)"
    n="${issue#\#}"
    body="$(gh issue view "$n" --repo "$GH_REPO" --json body -q .body)" ||
        die "could not read GH issue #$n"
    source="#$n"
fi

format_flags=()
if [ "$require_plan_evidence" = true ]; then
    format_flags+=(--require-plan-evidence)
fi
format="$(python3 "$HERE/lib/spec-structure.py" "${format_flags[@]}" <<<"$body")"
FINDINGS="$(jq -ce '.findings' <<<"$format")"
add() {
    FINDINGS="$(jq -c --arg severity "$1" --arg check "$2" --arg message "$3"         '. + [{severity:$severity, check:$check, message:$message}]' <<<"$FINDINGS")"
}

# --- 9. plan items vs live sub-issues (the real drift check) ---------------
if [ -z "$body_file" ]; then
    subs="$("$HERE/sync.sh" list-subissues --parent "$n")"
    plan_titles="$(jq -r '.planTitles[]' <<<"$format")"
    while IFS= read -r t; do
        [ -n "$t" ] || continue
        jq -e --arg t "$t" 'any(.[]; .title == $t)' <<<"$subs" >/dev/null ||
            add warn plan-subissues "plan item has no sub-issue: $t"
    done <<<"$plan_titles"
    while IFS= read -r t; do
        [ -n "$t" ] || continue
        grep -qxF "$t" <<<"$plan_titles" ||
            add error plan-subissues "open sub-issue not in the plan: $t"
    done < <(jq -r '.[] | select(.state=="OPEN") | .title' <<<"$subs")

    # --- 10. JIRA mirror marker ------------------------------------------------
    grep -qE '^JIRA: [A-Z][A-Z0-9]+-[0-9]+' <<<"$body" ||
        add warn traceability "no 'JIRA: <KEY>' marker in the issue body"
fi

# --- report ----------------------------------------------------------------
errors="$(jq '[.[] | select(.severity=="error")] | length' <<<"$FINDINGS")"
warns="$(jq '[.[] | select(.severity=="warn")] | length' <<<"$FINDINGS")"

if [ "$as_json" -eq 1 ]; then
    jq -n --arg source "$source" --argjson f "$FINDINGS" \
        --argjson e "$errors" --argjson w "$warns" \
        '{source:$source, errors:$e, warnings:$w, findings:$f}'
else
    echo "===== loop analyze: $source ====="
    if [ "$errors" -eq 0 ] && [ "$warns" -eq 0 ]; then
        log "no findings"
    else
        jq -r '.[] | "  [\(.severity|ascii_upcase)] \(.check): \(.message)"' <<<"$FINDINGS"
        printf '\n%s error(s), %s warning(s)\n' "$errors" "$warns"
        echo "This command reports findings without editing the spec."
    fi
fi

[ "$errors" -eq 0 ] || exit 1
exit 0
