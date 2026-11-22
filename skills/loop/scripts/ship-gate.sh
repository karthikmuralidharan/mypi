#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=lib/readiness.sh
source "$HERE/lib/readiness.sh"
require_config

no_ci=false
required_checks='[]'
while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-ci)
            no_ci=true
            shift
            ;;
        --required-check)
            required_checks="$(jq -c --arg name "${2:?--required-check needs a name}" '. + [$name]' <<<"$required_checks")"
            shift 2
            ;;
        *) die "usage: loop ship-gate [--required-check NAME ... | --no-ci]" ;;
    esac
done
if [ "$no_ci" = true ]; then
    [ "$required_checks" = '[]' ] || die "use --no-ci or --required-check"
else
    [ "$required_checks" != '[]' ] || die "specify the required CI check names, or use --no-ci for a project without CI"
fi

repo="$(gh_repo)"
branch="$(git branch --show-current)"
[ -n "$branch" ] || die "check out the named PR branch"
run="$(run_identity "$branch")"
ticket="$(require_jira_ticket "$branch")"
binding="$(require_pr_binding "$branch" "$run")"
jira_branch_matches "$branch" "$ticket" || die "branch $branch must start with $ticket"
pr="$(jq -er '.number' <<<"$binding")"
pr_data="$(pr_snapshot "$repo" "$pr")"
head="$(jq -er '.headRefOid' <<<"$pr_data")"
pr_matches_run "$binding" "$branch" "$ticket" "$head" "$pr_data" ||
    die "PR #$pr does not match the recorded PR identity and issue scope"
[ "$(git rev-parse HEAD)" = "$head" ] || die "local HEAD differs from PR #$pr head $head"
evidence="$(evidence_identity "$branch" "$head" "$run")"

if [ "$no_ci" = false ]; then
    gh pr checks "$pr" --repo "$repo" --watch --interval 10 ||
        die "CI did not pass for PR #$pr"
fi
policy="$(jq -nc --argjson binding "$binding" --arg head "$head" --arg run "$run" --arg evidence "$evidence" \
    --argjson noCI "$no_ci" --argjson requiredChecks "$required_checks" \
    '{binding:$binding,head:$head,run:$run,evidence:$evidence,noCI:$noCI,requiredChecks:$requiredChecks}')"
pr_ready_now "$branch" "$ticket" "$binding" "$policy" "$pr_data" ||
    die "ship gate is pending for PR #$pr at $head; check live CI, review, and the PR head"
[ "$(run_identity "$branch")" = "$run" ] || die "the approved run changed while checking the PR"
[ "$(require_pr_binding "$branch" "$run")" = "$binding" ] || die "the PR binding changed while checking the PR"
state_set_json shipPass "$policy" "$branch"
log "ship gate clear for PR #$pr at $head"
