---
name: loop
description: Run a feature from an approved spec through implementation, review, integration tests, and a GitHub pull request with Jira traceability. Use when the user asks to run the engineering loop or requests this full workflow.
---

# Engineering loop

Keep the approved spec in the GitHub issue. Use Jira to mirror the issue hierarchy and PR status.

## Write in simple English

Apply the `simple-english` skill to all documentation the loop writes or edits.
This includes specs, behaviour criteria, plans, repository docs, and issue and
PR descriptions. Use pragmatic mode unless the user asks for STE. Run the
skill's self-check before you share or publish the text.

If the skill is unavailable, review the text for short sentences, active voice,
and plain words. Use one term for each concept. Preserve code, identifiers,
commands, and quoted output.

## Start or resume

- Run `loop start` on a local work branch. Use an isolated Git worktree when needed.
- Run the bundled `scripts/loop` from the project worktree. Read [operations](references/operations.md) for setup, resume, and ticket commands.
- If the request names an existing GitHub issue, use `loop sync review-issue --gh <number>` to read its title, body, and body hash. Read its current sub-issues before drafting. Read the Jira epic directly if the user supplies its key.
- On resume, run `loop where` and read the saved spec and live issue before taking action. Resolve any differences between local state and the remote records.

## 1. Agree on the spec and plan

1. Work with the user to write the [product one-pager](references/product-spec.md) and its behaviour criteria.
2. Follow the [technical spec](references/technical-spec.md) and its design principles. Show model and interface changes in fenced before-and-after code blocks. Cite affected callers and include sequence diagrams for the main flow and relevant error flows.
3. Save the spec and checklist with these Markdown headings. Use `## Product spec`, `## Behaviour criteria`, `## Technical spec`, and `## Plan`. Give each plan item a [verification step and expected result](references/technical-spec.md#implementation-plan). Run `loop analyze --body-file <spec.md> --require-plan-evidence`.
4. Show the spec and plan to the user in the current session. After approval, run `loop gate-pass 1 --spec-file <spec.md> --note <summary>`. Use the approved file in the next stage. Carry the approved product spec and behaviour criteria verbatim into the GitHub issue.

## 2. Approve the ticket and link it

1. Verify a supplied Jira epic with `loop find-epic --key <key>`. Otherwise, search with `loop find-epic <keywords>` and let the user select the epic. Use the named GitHub issue as the proposed parent.
2. Show the [ticket scope file](references/operations.md#link-the-tickets). Include the approved body, the reviewed body hash for an existing issue, and each existing sub-issue number. After approval, run `loop gate-pass 2 --scope-file <scope.json>`.
3. Follow the [ticket sequence](references/operations.md#link-the-tickets). Record the issue IDs and cross-links as each action succeeds. After an interrupted write, read the remote record before you retry.
4. Once the Jira story is recorded, run `loop name-branch <slug>` before you push. This gives the branch the story key prefix and carries the loop state forward.

## 3. Implement and verify

1. Read [integration verification](references/integration-testing.md). Run and record the baseline before changing code.
2. Implement the approved plan. Use the project’s normal entry points and existing test commands. Verify each plan item against its expected result and record evidence against the approved behaviour criteria.
3. Get an independent review against the approved spec. Give a reviewer the spec, worktree, and diff range. Use a fresh, read-only agent session or a human reviewer.
4. Fix actionable findings and run the required integration tests. Record the results and independent review for the final commit with `loop record-evidence`. [Evidence format](references/operations.md#record-evidence)

## 4. Open the PR and stay with it

1. Start the PR title with the recorded Jira story key. Run `loop check-names '<PR title>'` before you push or publish the title. Use `Closes #<number>` when the PR delivers the whole issue. For a partial PR, put `Refs #<number>` on its own line.
2. Run `loop bind-pr --pr <number> --base <branch>`. Use `--mode partial` for a partial PR and `--head-repo <owner/repo>` for an intended fork. Then run `loop sync auto-status --pr <number>`.
   Review the PR’s comments and threads. If the repository expects a bot review, wait for its result on the current PR head.
3. After each push, run the [ship gate](references/operations.md#check-the-pr). Inspect failures, fix them, and check again. If fixes fail the same check, use the [failure diagnosis guide](references/integration-testing.md#diagnose-repeated-failures). Report any external dependency or review decision that blocks further progress.
4. Verify that the independent review covers the final head. If later fixes changed the diff, ask the reviewer to check the final version. Run `loop where` before reporting readiness.
5. Record the approved behavior criteria that the evidence supports. After the PR merges, run `loop sync auto-status --pr <number>` again and verify the Jira status.
