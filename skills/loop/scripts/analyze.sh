#!/usr/bin/env bash
# analyze.sh — consistency check across the spec, the plan and the live
# sub-issues. Reports; never edits.
#
# This is the mechanical form of the GATE 1 self-check in
# references/technical-spec.md. Spec Kit's `analyze` is the same idea: it
# reports inconsistencies across spec/plan/tasks without touching files, so
# the agent cannot "fix" a finding by quietly rewriting intent.
#
# Reads the live GH issue body (the source of truth), not a local file, so it
# also catches the case where the issue and the working copy have diverged.
#
# Usage: analyze.sh [--gh <n>] [--json]
# Exit:  0 all checks pass, 1 one or more findings, 2 could not run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_config
require jq gh

GH_REPO="$(gh_repo)"
issue=""
as_json=0
while [ $# -gt 0 ]; do
    case "$1" in
    --gh)
        issue="$2"
        shift 2
        ;;
    --json)
        as_json=1
        shift
        ;;
    *) die "analyze: unexpected arg: $1" ;;
    esac
done
[ -n "$issue" ] || issue="$(state_read '.issue')"
[ -n "$issue" ] || die "no issue to analyze (pass --gh <n>, or run sync bootstrap first)"
n="${issue#\#}"

body="$(gh issue view "$n" --repo "$GH_REPO" --json body -q .body 2>/dev/null)" ||
    die "could not read GH issue #$n"

FINDINGS='[]'
add() { # add SEVERITY CHECK MESSAGE
    FINDINGS="$(jq -c --arg s "$1" --arg c "$2" --arg m "$3" \
        '. + [{severity:$s, check:$c, message:$m}]' <<<"$FINDINGS")"
}

has() { grep -qF "$1" <<<"$body"; }

# --- 1. the four top-level sections ----------------------------------------
for s in "## Product spec" "## Behaviour criteria" "## Technical spec" "## Plan"; do
    has "$s" || add error sections "missing top-level section: $s"
done

# --- 2. the five technical-spec subsections --------------------------------
for s in "### Architecture decision" "### Data models" "### Interfaces" \
    "### Folder structure" "### Workflows"; do
    has "$s" || add error spec-sections "missing technical-spec subsection: $s"
done

# --- 3. behaviour criteria must be checkable -------------------------------
bc="$(awk '/^## Behaviour criteria/{f=1;next} /^## /{f=0} f' <<<"$body" || true)"
bc_items="$(grep -cE '^[[:space:]]*- \[[ xX]\]' <<<"$bc" || true)"
[ "${bc_items:-0}" -gt 0 ] ||
    add error behaviours "no '- [ ]' criteria under Behaviour criteria"
if [ "${bc_items:-0}" -gt 0 ]; then
    gwt="$(grep -ciE 'given.*when.*then' <<<"$bc" || true)"
    [ "${gwt:-0}" -gt 0 ] ||
        add warn behaviours "criteria present but none in Given/When/Then form"
fi

# --- 4. plan must have work items ------------------------------------------
plan="$(awk '/^## Plan/{f=1;next} /^## /{f=0} f' <<<"$body" || true)"
plan_items="$(grep -cE '^[[:space:]]*- \[[ xX]\]' <<<"$plan" || true)"
[ "${plan_items:-0}" -gt 0 ] || add error plan "no '- [ ]' work items under Plan"

# --- 5. workflows need a rendered diagram ----------------------------------
has '```mermaid' || add error workflows "no \`\`\`mermaid block under Workflows"

# --- 6. interfaces rows need a consumer count ------------------------------
iface="$(awk '/^### Interfaces/{f=1;next} /^#{2,3} /{f=0} f' <<<"$body" || true)"
awk -F'|' '
  /^\|/ && $0 !~ /^\|[ -]*-[ -]*\|/ && $0 !~ /Interface *\|/ {
    n=NF-2                      # strip the empty leading/trailing fields
    if (n < 5) { print "cols:" $0; next }
    c=$(NF-1); gsub(/^[ \t]+|[ \t]+$/, "", c)
    if (c == "" || c == "?") print "consumers:" $0
  }' <<<"$iface" | while IFS= read -r row; do
    case "$row" in
    cols:*) echo "WARN|interfaces|interface row has fewer than 5 columns: ${row#cols:}" ;;
    consumers:*) echo "ERROR|interfaces|interface row has no consumer count: ${row#consumers:}" ;;
    esac
done >/tmp/analyze.iface.$$ || true
while IFS='|' read -r sev chk msg; do
    [ -n "${sev:-}" ] || continue
    add "$(tr '[:upper:]' '[:lower:]' <<<"$sev")" "$chk" "$msg"
done </tmp/analyze.iface.$$
rm -f /tmp/analyze.iface.$$

# --- 7. data-model rows must state the change kind -------------------------
dm="$(awk '/^### Data models/{f=1;next} /^#{2,3} /{f=0} f' <<<"$body" || true)"
dm_rows="$(grep -cE '^\|' <<<"$dm" || true)"
if [ "${dm_rows:-0}" -gt 2 ]; then
    unmarked="$(grep -E '^\|' <<<"$dm" |
        grep -vE '^\|[ -]*-[ -]*\|' | grep -viE 'Entity *\|' |
        grep -cviE '\|[[:space:]]*(new|modified|removed)[[:space:]]*\|' || true)"
    [ "${unmarked:-0}" -eq 0 ] ||
        add error data-models "$unmarked data-model row(s) not marked new/modified/removed"
fi

# --- 8. folder tree must be marked -----------------------------------------
fs="$(awk '/^### Folder structure/{f=1;next} /^#{2,3} /{f=0} f' <<<"$body" || true)"
if [ -n "${fs//[[:space:]]/}" ]; then
    grep -qE '(NEW|MOD|DEL)' <<<"$fs" ||
        add warn folders "folder tree has no NEW/MOD/DEL markers"
fi

# --- 9. plan items vs live sub-issues (the real drift check) ---------------
subs="$(gh api graphql \
    -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){subIssues(first:100){nodes{number title state}}}}}' \
    -f o="${GH_REPO%/*}" -f r="${GH_REPO#*/}" -F n="$n" \
    -q '.data.repository.issue.subIssues.nodes' 2>/dev/null || echo '[]')"
plan_titles="$(grep -E '^[[:space:]]*- \[[ xX]\]' <<<"$plan" |
    sed -E 's/^[[:space:]]*- \[[ xX]\][[:space:]]*//' || true)"
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

# --- report ----------------------------------------------------------------
errors="$(jq '[.[] | select(.severity=="error")] | length' <<<"$FINDINGS")"
warns="$(jq '[.[] | select(.severity=="warn")] | length' <<<"$FINDINGS")"

if [ "$as_json" -eq 1 ]; then
    jq -n --arg issue "#$n" --argjson f "$FINDINGS" \
        --argjson e "$errors" --argjson w "$warns" \
        '{issue:$issue, errors:$e, warnings:$w, findings:$f}'
else
    echo "===== loop analyze: issue #$n ====="
    if [ "$errors" -eq 0 ] && [ "$warns" -eq 0 ]; then
        log "spec, plan and sub-issues are consistent"
    else
        jq -r '.[] | "  [\(.severity|ascii_upcase)] \(.check): \(.message)"' <<<"$FINDINGS"
        printf '\n%s error(s), %s warning(s)\n' "$errors" "$warns"
        echo "This reports only. Fix the spec or the plan yourself — if the"
        echo "contract itself is wrong, that is a replan, not an edit."
    fi
fi

[ "$errors" -eq 0 ] || exit 1
exit 0
