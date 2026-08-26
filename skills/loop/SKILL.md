---
name: "loop"
description: "Repo-agnostic engineering loop: brainstorm a product spec, co-develop a technical spec with mermaid diagrams, plannotate the plan, use graphify as an LLM wiki, implement, run an internal review, add no-mock integration tests, open a PR, address Copilot review, and tail CI until green — with full GitHub-issue↔JIRA traceability. Use when the user says 'run the loop', 'loop this', 'full loop on X', or wants the end-to-end plan→ship→trace pipeline. The GitHub issue body is the source of truth for specs; JIRA mirrors the hierarchy."
version: 1
created: "2026-07-26"
updated: "2026-08-26"
---

## When to Use

Use for a **feature-sized** unit of work that should go through the full
plan → build → review → ship → trace pipeline with GitHub↔JIRA bookkeeping.
Trigger phrases: "run the loop", "loop this", "full loop on X".

Do **not** use for a trivial one-line fix (just do it) or for pure research
(use `/skill:research` or `ce-brainstorm` directly).

This skill is **repo-agnostic**. It reads per-repo settings from
`.loop/config.json` (gitignored, written by `loop setup`) and calls
the helper scripts that ship beside this SKILL.md at
`<skill-dir>/scripts/loop`. Nothing repo-specific is hardcoded.

## Two hard gates (checked by the scripts, not just remembered)

1. **GATE 1, after tech spec + plan** — stop and get explicit human approval
   of the technical spec (with mermaid) and the plannotated plan before
   writing code. Record the approval:

   ```bash
   "$EL" gate-pass 1 --note "<one line: what was approved>"
   ```

2. **GATE 2, before any JIRA/GitHub ticket _create_ or _content mutate_** —
   show the exact issue title, parent epic, and hierarchy, and get a "yes"
   before calling `sync create-issue` / `sync mirror-jira` / `sync
   add-subissue` / `sync mirror-subtask` / `sync link` / `sync bootstrap`.
   Record the approval before making any of those calls:

   ```bash
   "$EL" gate-pass 2 --note "<one line: what was approved>"
   ```

   Reads (`find-epic`) never need approval. **`sync status` and `sync
   auto-status` are exempt** — once the ticket is confirmed at GATE 2, its
   status tracks the PR lifecycle automatically (see "Automatic status
   sync" below), so no per-transition prompt is needed.

Each `sync` create/mutate subcommand calls `require_gate 2` before it does
anything. It refuses to run with a clear error until `gate-pass 2` has run
for this branch. This is a real check in the script, not only a rule in
this document — a long session cannot forget it and slip past GATE 2 by
accident. The approval, with its timestamp and note, is stored in
`.loop/state/<branch>.json` (see "Run state and resuming a session" below).

At every gate, present the artifact and wait. Do not proceed on ambiguity.

## The ship gate (Stage 8–9): rearms on every push

Stage 8 (PR + review) and Stage 9 (CI) are **not two one-shot stages**. They
are one converging gate. A push always rearms it in full, on both axes:

- Fixing a CI failure and pushing does **not** carry forward an earlier
  review approval. A new commit can trigger a fresh Copilot pass or make a
  prior human approval stale.
- Addressing a review comment and pushing does **not** carry forward a
  previous green CI run. CI must be re-watched from that commit.

The loop is not done shipping until **one pass** finds both clear, with no
push in between:

```bash
"$EL" ship-gate
```

`ship-gate` composes `ci-watch` (CI, deterministic, existing) and `pr-check`
(review, deterministic, checks for `CHANGES_REQUESTED` and unresolved review
threads, including Copilot's line comments) into **one call, one exit
code**. It always runs both, so a CI failure never hides an unrelated review
problem. If it exits non-zero, fix, push, and run `ship-gate` again from the
top. Never special-case "just a CI fix" or "just a review nit" as a reason
to skip half the check. `ship-gate` always checks both.

On a clear pass, `ship-gate` records the commit it passed against in
`.loop/state/<branch>.json`. Run `"$EL" where` at any point to check that
this recorded commit still matches the branch tip. If it does not match, a
push landed after the last clear pass, and `where` reports this as drift —
a mechanical check for the exact mistake this section warns about, not only
a reminder to remember it.

## Run state and resuming a session

Every branch has one state file: `.loop/state/<branch>.json`. The scripts
write to it as a side effect of work they already do — `gate-pass` records
gate approval, `sync create-issue`/`mirror-jira` record the issue and JIRA
key, `sync auto-status` records the PR number, and `ship-gate` records its
last clear commit. Nothing here is a second copy of information the agent
must remember to update by hand; each fact is written once, by the call
that already produces it.

This solves a real problem: a `/loop` run can span many turns, a session
restart, or a compaction. Shell variables like `$ISSUE` and `$JIRA` do not
survive any of those. The state file does.

**Starting a new session, or resuming one, always run this first:**

```bash
"$EL" where
```

It reports, for the current branch: whether each gate is passed, whether
the tracked GitHub issue and JIRA key still resolve, whether a PR exists
and matches what state recorded, and whether the ship gate is still clear
for the current commit. Exit code 0 means state and live facts agree —
pick the stage back up from what `where` reports. Exit code 1 means it
found drift; read the reported lines before doing anything else, since one
of the tracked facts (an issue, a JIRA key, a PR, or the ship gate) no
longer matches reality.

`sync status` and `sync auto-status` read `--jira` and `--pr` from state
when the flag is omitted, so a resumed session does not need those values
held in memory to keep driving the ticket status.

`LOOP_SKIP_GATE_CHECK=1` bypasses the GATE 2 check on `sync`'s create/mutate
subcommands. This exists for standalone or test runs of `sync.sh` outside a
real `/loop` run (for example, the integration-test workflow in this
skill's own toolkit calls `sync bootstrap` directly). Do not set it during
a real run to skip a gate.

## Prerequisites (run once per repo)

The helper scripts live beside this skill at
`~/.pi/agent/skills/loop/scripts/loop`. Set a shell alias for the run:

```bash
EL=~/.pi/agent/skills/loop/scripts/loop

"$EL" setup      # detects gh repo, verifies Atlassian auth, asks JIRA project key
```

`setup` writes `.loop/config.json` and appends `.loop/` to
`.gitignore`. Atlassian credentials come from env
(`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN`) or `~/.config/fish/config_secrets.fish`
— never stored in the repo. If `setup` has not run, every write subcommand
dies with a clear message; run it first.

## Procedure

Track the whole run with the `todo` tool (one task per stage). Work in an
isolated worktree when the change is non-trivial (see `ce-worktree`).

### Stage 0 — Frame the work

- Restate the request in one sentence. Pick a short kebab `<slug>`.
- Decide worktree vs. in-place. For anything multi-file, create a worktree
  on a meaningfully-named branch (`feat/<slug>`), not an auto-generated name.

### Stage 1 — Product spec (one-pager)

- Run the **`ce-brainstorm`** flow to co-develop a _product_ one-pager. Keep
  it simple and functional. It MUST contain:
  - **Functional requirements** (what it does),
  - **Non-functional requirements** (perf, security, reliability, limits),
  - **Behaviour test success criteria** as a checklist of observable
    `Given/When/Then`-style bullets that a test can later assert.
- **Write the PRD with the `simple-english` skill — never skip this.** Load
  it, pick pragmatic mode by default (strict only if the human names
  ASD-STE100/STE explicitly), classify the spec as descriptive text, and
  apply the structural rules: short sentences (25-word cap), active voice,
  no filler ("leverage", "robust", "seamlessly"), no banned modals
  (`should`/`would`/`may`/`might`/`could` → `must`/`can`), no contractions.
  Run the skill's self-check before the spec leaves this stage. Code
  identifiers, CLI commands, and quoted errors stay untouched per the
  skill's Untouchables — this is prose discipline, not a rewrite of
  technical content.
- Hold the product spec as Markdown in memory / a scratch file for now; it
  becomes the top of the GitHub issue body at Stage 4, carried over
  verbatim — do not re-loosen the language when assembling the issue body.

### Stage 2 — Technical spec + mermaid (GATE 1 begins here)

- Co-develop a _technical_ spec from the product spec (use `ce-plan` thinking).
  Capture key workflows as **mermaid `sequenceDiagram`** blocks (they render
  natively in the GitHub issue body — the source of truth). Cover the main
  happy path plus the important failure/edge flows.
- Where the design touches unclear dependencies, use **graphify** as an LLM
  wiki to ground it (see Stage 3a), and cite what you learned in the spec.

### Stage 3 — Plannotate the plan

- Turn the tech spec into an execution plan as a Markdown checklist.
- Hand off to **plannotator**: enter plan mode (`/plannotator <plan-file>` or
  `pi --plan`), let the agent call `plannotator_submit_plan`, and iterate on
  the plan in the browser UI until the human **approves**. Approve-with-notes
  and deny-with-annotations both feed structured feedback back here.
- **GATE 1**: do not leave this stage until the plan is human-approved, then
  record it: `"$EL" gate-pass 1 --note "<what was approved>"`.

### Stage 3a — graphify as the LLM wiki (as needed, keep it fresh)

- If `graphify-out/graph.json` exists, answer dependency questions with
  `graphify query "<question>"` (fast path — no rebuild).
- After the change lands (Stage 5+), refresh it: `/graphify <path> --update`
  so the wiki stays current. Treat graphify as living documentation of
  dependencies, updated in the same loop that changes them.

### Stage 4 — Create the tracked issue + JIRA mirror (GATE 2)

The **GitHub issue body is the source of truth**. Build it as:

```
## Product spec
<functional + non-functional -- simple-english compliant, carried from Stage 1>
## Behaviour criteria
- [ ] Given ... When ... Then ...
## Technical spec
<prose + ```mermaid sequenceDiagram ...``` >
## Plan
- [ ] work item 1
- [ ] work item 2
```

- **Find the parent epic first and confirm** (never guess):
  `"$EL" find-epic "<feature keywords>"` → present candidates → the human
  picks one. This is required for JIRA traceability.
- **GATE 2**: show the human the issue title, the chosen epic, and the planned
  sub-issue breakdown. On approval, record it, then run the whole sequence
  in **one call**:

  ```bash
  "$EL" gate-pass 2 --note "issue + epic + sub-issue breakdown approved"
  RESULT=$("$EL" sync bootstrap --title "<slug>: <title>" --body-file spec.md \
             --epic <EPIC> --subitem "<item 1>" --subitem "<item 2>")
  ISSUE=$(jq -r .issue <<<"$RESULT")
  JIRA=$(jq -r .jira <<<"$RESULT")
  ```

  `bootstrap` runs `create-issue` → `mirror-jira` → (`add-subissue` +
  `mirror-subtask` per `--subitem`) and prints one JSON summary. It also
  records `$ISSUE`/`$JIRA` into `.loop/state/<branch>.json` as it creates
  them, so later calls in this session or a resumed one can omit `--jira`
  and read it back from state. Still idempotent (labels `gh-issue-<n>` /
  `jira:<KEY>` dedupe), so re-running never creates duplicates. It
  cross-links both ways (JIRA remote link + a `JIRA: <KEY>` marker in the
  issue body).
- Move JIRA to In Progress: `"$EL" sync status --to "In Progress"` (reads
  the JIRA key from state; pass `--jira "$JIRA"` explicitly only if state
  has not been written yet in this exact call sequence). From here on,
  status is **auto-synced** to the PR lifecycle without a gate (the ticket
  is already confirmed) — see "Automatic status sync".

### Automatic status sync (no approval gate — but still needs a call)

Once the JIRA ticket exists and is confirmed, drive its status from the PR's
**actual state**, read deterministically, instead of the agent remembering
which PR event maps to which transition across many turns:

```bash
"$EL" sync auto-status --jira "$JIRA" --pr "$PR"
```

It reads the PR's `state` via `gh pr view` and picks the transition itself
— no per-transition prompt needed (the ticket is already confirmed at GATE 2):
- `OPEN` → "In Progress"
- `MERGED` → "Done"
- `CLOSED` (unmerged) → no-op, leaves status as-is (never auto-revert)
"No approval gate" does **not** mean a background daemon does this for you
— there is no watcher. Call `sync auto-status` at PR-open (Stage 8), at every
ship-gate pass (Stage 9), and once more after merge (Stage 10); each call is
idempotent (a no-op if the target state is already set, or if the board
lacks that exact state). If the board has no "In Review" state (as in
SWONE), "In Progress" is the open-PR state and "Done" the merged state.

### Stage 5 — Implement

- **Dispatch `ce-work` to a subagent.** Do not load its full skill body
  into this orchestrating session — a long `/loop` run already carries the
  product spec, tech spec, and plan in context, and `ce-work` is one of the
  two heaviest skills this pipeline touches. Only its completion summary
  needs to come back here:

  ```
  subagent(agent: "worker", skill: "ce-work", task: "Implement the approved
    plan for <slug> (issue #<n>). Plan: <link or paste>. Keep changes
    surgical; check off plan items in the GitHub issue as they land.")
  ```

  Run this in the foreground (no `async: true`) — Stage 6 needs Stage 5's
  result before it can start.
- If the change touches paths under a living doc's "update when" table
  (e.g. `docs/connect/reference/*`), tell the subagent to update that doc
  in the same change.

### Stage 6 — Internal code review

- **Dispatch `ce-code-review` to a subagent**, for the same reason as Stage
  5: it already dispatches its own tiered persona reviewers internally, so
  running it in-process buys nothing and adds its full skill body plus
  every persona's findings to this session's context.

  ```
  subagent(agent: "worker", skill: "ce-code-review", task: "Review the
    changes for <slug> against the plan/spec. Focus: alignment with the
    plan/spec, security vectors, readability, and architecture. Push to
    simplify and reduce line count where behaviour is preserved.")
  ```

  Read back only the findings summary. Address findings before proceeding
  — dispatch a follow-up `ce-work` subagent for fixes, do not patch them
  directly in this session.
- Optionally open the diff in **plannotator** review (`/plannotator-review`)
  for line-level annotation.

### Stage 7 — No-mock integration tests

- Add integration tests that exercise **real** collaborators (no mocks):
  real DBs/emulators, testcontainers, in-process real servers. In this repo
  family that means `-tags integration` tests / the e2e suite, not stubbed
  interfaces. Assert the Stage 1 behaviour criteria.

### Stage 8 — PR + Copilot review

- Ship with **`ce-commit-push-pr`**: conventional-commit title carrying the
  repo's ticket prefix if it uses one (e.g. `SWONE-NNN type(scope): ...`),
  value-first PR description linking the GitHub issue (`Closes #<n>`).
- Capture the PR number and sync its status right away:
  `PR=$(gh pr view --json number -q .number)` then
  `"$EL" sync auto-status --jira "$JIRA" --pr "$PR"` (see "Automatic status
  sync" above — deterministic, no approval gate).
- Wait for **Copilot** review, then address its comments (see
  `ce-resolve-pr-feedback`). Push fixes — this **rearms the ship gate** (see
  above): `ship-gate` must pass again from that push.

### Stage 9 — Converge the ship gate

```bash
"$EL" ship-gate         # ci-watch + pr-check, one call, one exit code
```

- If it fails, the output says which side(s) failed (CI's failing-job tail,
  and/or pr-check's outstanding-thread summary). Fix, push, and re-run
  `ship-gate` from the top.
- The loop is only done shipping once one `ship-gate` pass exits 0.

### Stage 10 — Close out traceability

- Tick the remaining behaviour-criteria checkboxes in the issue.
- After merge, run `"$EL" sync auto-status --jira "$JIRA" --pr "$PR"` once
  more — it reads the merged state and lands on **Done** (no approval gate,
  but this call is what actually performs the transition; see "Automatic
  status sync").

## Automation surface (what is code vs. judgment)

Hard-automated (scripts, deterministic, idempotent):
- Atlassian auth + config (`loop setup`, `common.sh`).
- Epic discovery (`find-epic`).
- GH issue + real sub-issues, JIRA story/sub-task mirror, bidirectional
  cross-link, status transitions incl. PR-state-driven auto-status, and the
  GATE-2 create+mirror sequence as one call (`sync`, incl. `bootstrap`).
- CI tailing + failing-log surfacing (`ci-watch`).
- Review-thread / changes-requested check (`pr-check`) — the ship gate's
  review-side counterpart to `ci-watch`.
- The ship gate itself as one call/one exit code (`ship-gate` = `ci-watch` +
  `pr-check`).
- Gate approval, tracked issue/JIRA/PR, and last-clear-ship-gate commit, all
  persisted per branch and enforced or checked at the point of use
  (`gate-pass`, `require_gate` inside `sync`, `where`).

Guided (human-in-the-loop, judgment-heavy — orchestrated, not scripted):
- Brainstorm/spec/plan via the `ce-*` skills, in this session.
- Implement/review via **subagent dispatch** of `ce-work`/`ce-code-review` —
  guided in the sense that a human still approves the plan and the findings,
  but the reasoning itself runs in a subagent, not this session.
- plannotator plan + code review UIs.
- graphify wiki queries/refresh.

## Pitfalls

- **Never** run a `sync` **create/mutate** subcommand (`create-issue`,
  `mirror-jira`, `add-subissue`, `mirror-subtask`, `link`, `bootstrap`)
  before GATE 2 approval. This is enforced (`require_gate 2` dies with a
  clear message), not only a rule to remember — but `LOOP_SKIP_GATE_CHECK=1`
  can bypass it, so do not set that variable during a real run. `sync
  status`/`sync auto-status` are exempt once the ticket is confirmed.
- **Never** guess the epic — always `find-epic` and confirm.
- **Never** treat a push as clearing only the check it was meant to fix. A
  CI-only fix can still be sitting on stale/unresolved review threads; a
  review-only fix still needs a fresh CI run. Always re-run `ship-gate`
  (never `ci-watch`/`pr-check` individually) after any push to the PR branch.
  Run `"$EL" where` if unsure whether the last clear ship-gate pass still
  covers the current commit.
- `pr-check` only sees formal reviews and line-level review threads — a
  bot/human comment posted as a plain top-level PR comment won't be caught;
  skim the PR comment stream by eye too before calling the ship gate clear.
- JIRA Cloud v3 needs ADF for description/create bodies; `common.sh adf_doc`
  handles it. Team-managed projects link stories to epics via `fields.parent`,
  not the classic epic-link custom field (verified for SWONE).
- This repo has **no local `.github/workflows`** — CI is org-level, so
  `ci-watch` resolves runs by branch, not by workflow name. Other repos with
  local workflows still work (same branch-based resolution).
- Integration tests must use real collaborators; a mock defeats Stage 7.
- Keep `.loop/` gitignored (setup does this) — it may hold local config and
  run state.
- **Never** skip the `simple-english` pass on the Stage 1 product spec — the
  Stage 4 issue body inherits that section verbatim, so slop that leaks in
  at Stage 1 ships straight into the tracked issue.
- **Starting a new session or returning after a compaction**: run `"$EL"
  where` before anything else. Do not re-derive stage/gate state from
  conversation history alone — history can be summarized away; the state
  file and live `gh`/JIRA/git facts cannot.
- Dispatching `ce-work`/`ce-code-review` to a subagent (Stage 5/6) still
  needs this session to enforce the gates and hard rules above — a
  subagent implementing the plan does not bypass GATE 1/GATE 2, since
  those gates sit in front of Stage 4/5, before any subagent is dispatched.

## Verification

- `loop config` prints the resolved repo/site/project.
- `loop find-epic <kw>` returns candidate epics (auth + project OK).
- `sync` re-runs are no-ops when the counterpart already exists (idempotent).
- `sync` create/mutate subcommands refuse to run before `loop gate-pass 2`
  has recorded approval for the branch, and proceed once it has.
- `loop ship-gate` exits 0 only when CI is green and the PR is review-clear
  in the same pass — that's the actual "ready to merge" signal, not either
  underlying check alone. On a clear pass, it records the passing commit.
- `loop where` exits 0 when the state file agrees with live `gh`/JIRA/git
  facts, and exits 1 with the mismatched fact named, when it does not.
- A completed run leaves: a GH issue (spec source of truth) with sub-issues,
  a mirrored JIRA story/sub-tasks under the confirmed epic, cross-links both
  ways, a merged PR closing the issue, and green CI.
- The issue body's `## Product spec` section passes the `simple-english`
  self-check: no sentence over the 25-word descriptive cap, no banned modals
  or contractions, no filler words.
