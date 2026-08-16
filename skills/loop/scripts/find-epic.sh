#!/usr/bin/env bash
# find-epic.sh — search the configured JIRA project for candidate epics
# matching a keyword, so a human can confirm the right parent BEFORE any
# story is created.
#
# Usage:  find-epic.sh "tunnel telemetry"
# Output: tab-separated  KEY <TAB> SUMMARY <TAB> STATUS  (newest first).
#
# This is the "find existing epic first and confirm" gate. It only reads.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_config

query="${1:-}"
[ -n "$query" ] || die "usage: find-epic.sh <keyword...>"

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
