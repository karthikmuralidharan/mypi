#!/usr/bin/env bash
# ci-watch.sh — watch CI for the current branch's PR until it settles, then
# print a compact pass/fail summary. Uses `gh pr checks --watch`, which reads
# GitHub's unified checks API and works regardless of which CI provider is
# actually wired up (GitHub Actions, CircleCI, etc.). An earlier version of
# this script assumed GitHub Actions specifically via `gh run list`, which
# hangs forever (then dies) on repos whose CI is anything else (e.g.
# mcp-fabric, which runs CircleCI, not GitHub Actions).
#
# Usage: ci-watch.sh [branch]   (defaults to current branch)
# Exit:  0 if all checks passed. Non-zero if any failed, none exist yet, or
#        no open PR was found for branch (see `gh help exit-codes`).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
repo="$(gh_repo)"
log "watching CI for $repo @ $branch (via gh pr checks — provider-agnostic)"

pr_num="$(gh pr list --repo "$repo" --head "$branch" --json number -q '.[0].number' 2>/dev/null || true)"
[ -n "$pr_num" ] || die "no open PR found for branch $branch (repo $repo) — ci-watch reads checks off a PR, open one first"

echo "----- watching CI for PR #$pr_num -----"
rc=0
gh pr checks "$pr_num" --repo "$repo" --watch || rc=$?

if [ "$rc" -ne 0 ]; then
    warn "CI not green for PR #$pr_num (exit $rc) — see check links above for failing-job logs"
fi
exit "$rc"
