#!/usr/bin/env bash

pr_matches_run() {
    local binding="$1" branch="$2" ticket="$3" head="$4" data="$5"
    pr_binding_matches "$binding" "$branch" "$ticket" "$data" || return 1
    jq -e --arg head "$head" '.headRefOid == $head and .state == "OPEN" and .isDraft == false' <<<"$data" >/dev/null
}

pr_review_clear() {
    local repo="$1" number="$2" head="$3" reviews
    reviews="$(gh api graphql --paginate --slurp -f query='
        query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String) {
            repository(owner:$owner,name:$repo) {
                pullRequest(number:$pr) {
                    headRefOid
                    reviewDecision
                    reviewThreads(first:100,after:$endCursor) {
                        nodes { isResolved }
                        pageInfo { hasNextPage endCursor }
                    }
                }
            }
        }' -f owner="${repo%/*}" -f repo="${repo#*/}" -F pr="$number")" || return 1
    jq -e --arg head "$head" '
        length > 0 and all(.[].data.repository.pullRequest;
            .headRefOid == $head and
            (.reviewDecision == null or .reviewDecision == "APPROVED") and
            (.reviewThreads.nodes | type == "array" and all(.[]; .isResolved == true)))
    ' <<<"$reviews" >/dev/null
}

pr_ci_clear() {
    local repo="$1" head="$2" policy="$3" data="$4" pages
    pages="$(gh api graphql --paginate --slurp -f query='
        query($owner:String!, $repo:String!, $head:GitObjectID!, $endCursor:String) {
            repository(owner:$owner,name:$repo) {
                object(oid:$head) {
                    ... on Commit {
                        oid
                        statusCheckRollup {
                            contexts(first:100,after:$endCursor) {
                                nodes {
                                    ... on CheckRun { name status conclusion }
                                    ... on StatusContext { context state }
                                }
                                pageInfo { hasNextPage endCursor }
                            }
                        }
                    }
                }
            }
        }' -f owner="${repo%/*}" -f repo="${repo#*/}" -f head="$head")" || return 1
    jq -e --arg head "$head" --argjson policy "$policy" --argjson pr "$data" '
        def pass: .state == "SUCCESS" or (.status == "COMPLETED" and .conclusion == "SUCCESS");
        def allowed: pass or (.status == "COMPLETED" and (.conclusion == "SKIPPED" or .conclusion == "NEUTRAL"));
        map(.data.repository.object) as $commits |
        select(($commits | length) > 0 and all($commits[]; .oid == $head)) |
        [$commits[] | .statusCheckRollup.contexts.nodes[]?] as $checks |
        ($checks + ($pr.statusCheckRollup // [])) as $seen |
        if $policy.noCI then ($seen | length) == 0
        else ($policy.requiredChecks | length) > 0 and all($seen[]; allowed) and
            all($policy.requiredChecks[]; . as $name |
                any($checks[]; (.name // .context) == $name and pass) and
                all($seen[] | select((.name // .context) == $name); pass))
        end
    ' <<<"$pages" >/dev/null
}

pr_ready_now() {
    local branch="$1" ticket="$2" binding="$3" policy="$4" data="$5"
    local pr repo head_repo head latest evidence
    pr="$(jq -er '.number' <<<"$binding")" || return 1
    repo="$(jq -er '.repo' <<<"$binding")" || return 1
    head_repo="$(jq -er '.headRepo' <<<"$binding")" || return 1
    head="$(jq -er '.head' <<<"$policy")" || return 1
    jq -e --argjson binding "$binding" '.binding == $binding' <<<"$policy" >/dev/null || return 1
    pr_matches_run "$binding" "$branch" "$ticket" "$head" "$data" || return 1
    evidence="$(evidence_identity "$branch" "$head" "$(jq -er '.run' <<<"$policy")")" || return 1
    [ "$evidence" = "$(jq -er '.evidence' <<<"$policy")" ] || return 1
    pr_review_clear "$repo" "$pr" "$head" || { warn "review approval or thread resolution is pending"; return 1; }
    latest="$(pr_snapshot "$repo" "$pr")" || return 1
    pr_matches_run "$binding" "$branch" "$ticket" "$head" "$latest" || return 1
    jq -e '.reviewDecision == null or .reviewDecision == "" or .reviewDecision == "APPROVED"' <<<"$latest" >/dev/null || return 1
    # GitHub applies the base branch policy, including any required app or test merge commit.
    jq -e '.mergeable == "MERGEABLE" and .mergeStateStatus == "CLEAN"' <<<"$latest" >/dev/null ||
        { warn "GitHub has not cleared the merge state and base branch policy"; return 1; }
    pr_ci_clear "$head_repo" "$head" "$policy" "$latest" || { warn "CI is pending or required checks did not pass"; return 1; }
    [ "$(git rev-parse "refs/heads/$branch")" = "$head" ]
}
