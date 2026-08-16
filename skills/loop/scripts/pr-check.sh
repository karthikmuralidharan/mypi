#!/usr/bin/env bash
# pr-check.sh — read-only gate on PR review state for the current branch.
# Counterpart to ci-watch.sh: ci-watch gates on CI, pr-check gates on review.
# The loop skill treats every push as rearming BOTH — see SKILL.md's
# "Ship gate" section. Neither script alone means "ready to merge".
#
# Usage: pr-check.sh [branch]   (defaults to current branch)
# Exit:  0 if there's an open PR with no unresolved review threads and no
#        outstanding "changes requested" decision. 1 otherwise, printing
#        what's outstanding so the loop knows what to address next.
#
# Known limitation: this only sees line-level review threads and the formal
# review decision (covers Copilot's line comments and human reviews). A
# bot/human comment posted as a plain top-level PR *comment* (not a review)
# won't be caught here — skim the PR comment stream by eye too.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
repo="$(gh_repo)"
log "checking PR review state for $repo @ $branch"

pr_num="$(gh pr list --repo "$repo" --head "$branch" --json number -q '.[0].number' 2>/dev/null || true)"
[ -n "$pr_num" ] || die "no open PR found for branch $branch (repo $repo)"

data="$(gh api graphql -f query='
  query($o:String!,$r:String!,$n:Int!){
    repository(owner:$o,name:$r){
      pullRequest(number:$n){
        reviewDecision
        reviewThreads(first:100){ nodes{ isResolved isOutdated } }
      }
    }
  }' -f o="${repo%/*}" -f r="${repo#*/}" -F n="$pr_num")"

decision="$(jq -r '.data.repository.pullRequest.reviewDecision // "NONE"' <<<"$data")"
unresolved="$(jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' <<<"$data")"
outdated_unresolved="$(jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == true)] | length' <<<"$data")"

echo "----- PR review summary (#$pr_num) -----"
echo "  reviewDecision: $decision"
echo "  unresolved threads: $unresolved (of which outdated: $outdated_unresolved)"

if [ "$decision" = "CHANGES_REQUESTED" ] || [ "$unresolved" -gt 0 ]; then
    warn "PR #$pr_num is not review-clear — address the above, push, then re-run BOTH ci-watch and pr-check"
    exit 1
fi

log "PR #$pr_num is review-clear (pairs with a green ci-watch to be ship-ready)"
exit 0
