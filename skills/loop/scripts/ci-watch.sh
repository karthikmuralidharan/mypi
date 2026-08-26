#!/usr/bin/env bash
# ci-watch.sh — watch CI for the current branch's PR until it settles, then
# print a compact pass/fail summary. Uses `gh pr checks --watch`, which reads
# GitHub's unified checks API and works regardless of which CI provider is
# actually wired up (GitHub Actions, CircleCI, etc.). An earlier version of
# this script assumed GitHub Actions specifically via `gh run list`, which
# hangs forever (then dies) on repos whose CI is anything else (e.g.
# mcp-fabric, which runs CircleCI, not GitHub Actions).
#
# A repo with NO CI configured at all is a real, common case (verified
# directly against mypi itself, which has no .github/workflows) --
# `gh pr checks` reports "no checks reported on the '<branch>' branch" and
# exits 1 for this, identical to an actual check failure, even with --json.
# This script treats that exact message as "no CI configured" (non-blocking,
# exit 0), not a failure -- there is no cleaner structured signal gh offers
# to tell the two cases apart.
#
# Usage: ci-watch.sh [branch]   (defaults to current branch)
# Exit:  0 if all checks passed, or no CI is configured for this repo.
#        Non-zero if any check failed or no open PR was found for branch.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
repo="$(gh_repo)"
log "watching CI for $repo @ $branch (via gh pr checks — provider-agnostic)"

pr_num="$(gh pr list --repo "$repo" --head "$branch" --json number -q '.[0].number' 2>/dev/null || true)"
[ -n "$pr_num" ] || die "no open PR found for branch $branch (repo $repo) — ci-watch reads checks off a PR, open one first"

# Point-in-time probe first: if this PR has zero checks configured at all,
# --watch would otherwise just fail once with the same "no checks reported"
# message. Detect that case up front and treat it as N/A, not a failure.
probe="$(gh pr checks "$pr_num" --repo "$repo" 2>&1)" || true
if grep -q "no checks reported on" <<<"$probe"; then
    log "no CI checks configured for $repo — nothing to wait for, treating as clear"
    exit 0
fi

echo "----- watching CI for PR #$pr_num -----"
rc=0
gh pr checks "$pr_num" --repo "$repo" --watch || rc=$?

if [ "$rc" -ne 0 ]; then
    warn "CI not green for PR #$pr_num (exit $rc) — see check links above for failing-job logs"
fi
exit "$rc"
