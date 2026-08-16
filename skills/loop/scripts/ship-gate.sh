#!/usr/bin/env bash
# ship-gate.sh — the Stage 9 ship gate as ONE deterministic call instead of
# two. Composes ci-watch.sh + pr-check.sh, always runs both (so a CI failure
# doesn't hide an unrelated review problem or vice versa), and reduces the
# whole "is it ready to merge" check to a single tool call/exit code instead
# of the caller having to sequence two calls and remember to check both.
#
# Usage: ship-gate.sh [branch]
# Exit:  0 only if CI is green AND the PR is review-clear in this one pass.
#        Non-zero otherwise — stdout says which side(s) failed and why
#        (ci-watch's failing-job tail, pr-check's outstanding-thread summary).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"

ci_rc=0
"$HERE/ci-watch.sh" "$branch" || ci_rc=$?

pr_rc=0
"$HERE/pr-check.sh" "$branch" || pr_rc=$?

echo "===== ship gate summary (branch: $branch) ====="
if [ "$ci_rc" -eq 0 ] && [ "$pr_rc" -eq 0 ]; then
    log "ship gate CLEAR — CI green and review-clear in the same pass"
    exit 0
fi
[ "$ci_rc" -ne 0 ] && warn "CI: FAIL (see ci-watch output above)"
[ "$pr_rc" -ne 0 ] && warn "REVIEW: FAIL (see pr-check output above)"
warn "ship gate NOT clear — fix, push, and re-run ship-gate from the top"
exit 1
