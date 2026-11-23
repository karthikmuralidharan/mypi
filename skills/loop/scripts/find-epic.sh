#!/usr/bin/env bash
# find-epic.sh — search the configured JIRA project for candidate epics
# matching a keyword, so a human can confirm the right parent BEFORE any
# story is created.
#
# Usage:  find-epic.sh "tunnel telemetry" | --key <epic-key>
# Output: tab-separated  KEY <TAB> SUMMARY <TAB> STATUS  (newest first).
#
# This is the "find existing epic first and confirm" gate. It only reads.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_config

query="${1:-}"
[ -n "$query" ] || die "usage: loop find-epic <keywords> | --key <epic-key>"
if [ "$query" = --key ]; then
    key="${2:?--key requires an epic key}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*-[0-9]+$ ]] || die "invalid Jira issue key: $key"
    jira_curl GET "/issue/$key?fields=summary,status,issuetype,project" |
        jq -er --arg project "$JIRA_PROJECT" '
            select(.fields.project.key == $project) |
            select(.fields.issuetype.hierarchyLevel == 1 or .fields.issuetype.name == "Epic") |
            [.key, .fields.summary, .fields.status.name] | @tsv
        ' || die "could not verify $key as an epic in $JIRA_PROJECT"
    exit 0
fi

# text ~ does a fuzzy summary/description match; scope to open-ish epics.
# Escape the free-text keyword before it goes into the JQL literal —
# unescaped, a " or \ in the query breaks the JQL syntax.
jql="project = ${JIRA_PROJECT} AND issuetype = Epic AND text ~ \"$(jql_escape "$query")\" ORDER BY created DESC"

log "searching ${JIRA_PROJECT} epics for: ${query}"
jira_curl GET "/search/jql" -G \
    --data-urlencode "jql=${jql}" \
    --data-urlencode "maxResults=15" \
    --data-urlencode "fields=summary,status" |
    jq -r '.issues[]? | [.key, .fields.summary, (.fields.status.name // "")] | @tsv'
