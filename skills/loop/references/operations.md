# Loop operations

Use Git, Bash 4 or later, Python 3.8 or later, `gh`, `jq`, and `curl`. Authenticate `gh` first. Set `ATLASSIAN_SITE` to the trusted Jira hostname in your environment. Use `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` for Jira authentication. Keep credentials out of repo files.

On macOS, put your Bash 4 or later installation before `/bin/bash` in `PATH`. Run `bash --version` to check which Bash the commands will use.

Run the skill’s `scripts/loop` with the project worktree as the current directory. The examples use `loop` for that executable. Use its absolute path when the shell cannot find it.

Use the same skill folder in each coding agent. If an agent does not load
skills, give it `SKILL.md` and access to the rest of the folder. Use the
same CLI from the project worktree.

## Set up and resume

Run `loop setup` if the worktree has no `.loop/config.json`. It asks for the GitHub repository and Jira project. It records the site from `ATLASSIAN_SITE`, writes local config, and adds `.loop/` to `.gitignore`. In a new worktree, you can copy the config from the main checkout and keep the state local to the new worktree.

Run `loop start` on the work branch. Git keeps the run ID with that branch.
Use `loop start --new` when you reuse a branch for a different run. The new
run gets fresh approvals and retains the old state file for history.

`loop where` compares approvals, tickets, and the bound PR with live state.
It reports stale approvals, remote changes, and unavailable providers
separately. Run `loop state-path` to find the active state file. Keep draft
spec files under the ignored `.loop/` directory.

When upgrading a run without an ID, start a new run and record fresh approvals.
To keep existing tickets, approve their exact numbers and reviewed body.

## Link the tickets

Show the user a scope file with these fields. Use a title string for a new
child. For an existing child, use an object with its exact title and issue
number.

```json
{
  "repo": "owner/repo",
  "issue": null,
  "title": "Export reports",
  "epic": "ENG-17",
  "subissues": ["Add the report export", {"title": "Document CSV fields", "issue": 217}]
}
```

For an existing parent, run `loop sync review-issue --gh <number>` before
review. Set `issue` to its number and copy `baseBodyHash` from the same
snapshot as the body the user reviews. Keep that hash until approval. If the
body changes, show the new version before updating the scope. The script
checks the current body again just before an update. GitHub issue writes have
a short race between that read and the update.

After approval, run `loop gate-pass 2 --scope-file <scope.json>`. The command binds the scope to the approved spec and the configured Jira project. If the approved spec or scope changes, record the new approval before writing.

1. For a new parent, run `loop sync create-issue --title <title> --body-file <spec.md>`. For an existing parent, preserve its relevant content and Jira link in the approved body. Then run `loop sync update-issue --gh <number> --body-file <spec.md>` to save the issue in the run state.
2. Run `loop sync mirror-jira --gh <number> --epic <epic>` for the parent. The command adds a GitHub issue comment for the backlink and a remote link in Jira. Run `loop sync link --gh <number> --jira <key>` to restore missing links.
3. Read the current children with `loop sync list-subissues --parent <number>`. For each approved new child, run `loop sync add-subissue --parent <number> --title <title>`. Then run `loop sync mirror-subtask --gh <child-number> --jira-parent <key>`.
4. Run `loop analyze --gh <number>` to compare the live issue with the plan and children. Run `loop sync status --to 'In Progress'` when implementation starts.

Create commands record an operation ID before sending the request. Repeat
the same command to recover an issue or finish linking it. For a known issue
that search has not returned, pass `--known <number-or-key>` to the original
create or mirror command. The command checks that record before adopting it.
To attach an existing child, approve its number in the scope first.

The operation journal and lock are shared by worktrees in one clone. For the
same run across separate clones, use one writer. Jira can take time to index
a new issue. Use a known issue key or confirm that the first request did not
create a record through a source other than search. Then run
`loop sync clear-unconfirmed --operation <id>` and retry.
[Jira search consistency](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)

The Jira project must support the `Story` and `Sub-task` issue types, the
parent links used by the scope, and the `In Progress` and `Done` transitions.
If the project requires other fields or uses different names, resolve the
workflow with its owner before running ticket sync.

## Name the branch and PR

Use the recorded Jira story key at the start of both names. For story `ENG-42`, use a branch such as `ENG-42-export-reports` and a PR title such as `ENG-42 feat(reports): export CSV`.

After `loop sync mirror-jira`, run `loop name-branch <slug>` on the local work branch. The command carries approvals and ticket IDs to the new branch name. If the branch already has the right prefix, it keeps that name. If a branch needs a new name and already tracks a remote branch or has a recorded PR, use a new local branch.

Run `loop check-names '<PR title>'` before you push or publish the title. The ship gate checks the live branch name and PR title before it records a pass.

## Bind the PR

After opening the PR, run `loop bind-pr --pr <number> --base <branch>`. Use
`--head-repo <owner/repo>` for an intended fork. The command checks the actual
head repository, head branch, base, and current commit. It records the PR
number and the approved GitHub issue.

Use `Closes #<number>` for a full PR and confirm that GitHub reports the
closing relationship. Use `--mode partial` for a partial PR. Include a
visible `Refs #<number>` line for readers. The recorded binding links the
PR for Jira status sync.

`loop sync auto-status --pr <number>` uses only the bound PR. An open PR
maps to `In Progress`. A full PR that merges and closes the issue maps to
`Done`. A partial merge or a PR closed without merge keeps the Jira status.

## Record evidence

Keep evidence files under `.loop/`. Use the full SHA of the commit the tests
and independent review covered. After a fix, record updated evidence for the
new commit.

For tests, save JSON with `status`, `commands`, and `summary`. For example,
`{"status":"pass","commands":["make integration"],"summary":"12 tests passed"}`.
Run `loop record-evidence tests --commit <sha> --file <tests.json>`.

For review, save JSON with `status`, `reviewer`, and `summary`. Record the
independent reviewer's identity and the outcome. Run
`loop record-evidence review --commit <sha> --file <review.json>`.

## Check the PR

Use `loop ship-gate --required-check '<job name>'` after a push. Repeat the flag for each job that must report a successful result. Use the exact check names shown by `gh pr checks <number> --json name,bucket`. For a project without CI, use `loop ship-gate --no-ci` and keep the local test evidence.

The command checks the bound head, local test and review evidence, GitHub
merge state, and review threads. It checks the named CI jobs on the head
commit. GitHub evaluates the base branch rules. These rules can include
required apps or checks on the test merge commit. Inspect top-level PR
comments and expected bot reviews separately.
[GitHub required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

Before reporting readiness, run `loop where`. It checks live CI and review against the recorded ship policy. Merge only within the user’s requested scope. After merge, use `loop sync auto-status --pr <number>` to update Jira.

## Test the loop locally

Run `python3 tests/test_loop.py` from the skill directory. The tests use
temporary repositories and stub GitHub and Jira providers.
