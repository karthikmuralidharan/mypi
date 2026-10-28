---
name: "loop"
description: "Repo-agnostic engineering loop: brainstorm a product spec, co-develop a technical spec with mermaid diagrams, plannotate the plan, use graphify as an LLM wiki, implement, run an internal review, add no-mock integration tests, open a PR, address Copilot review, and tail CI until green — with full GitHub-issue↔JIRA traceability. Use when the user says 'run the loop', 'loop this', 'full loop on X', or wants the end-to-end plan→ship→trace pipeline. The GitHub issue body is the source of truth for specs; JIRA mirrors the hierarchy."
version: 1
created: "2026-07-26"
updated: "2026-08-27"
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

**Every push gets an immediate `"$EL" ship-gate` call** — never `ci-watch` or
`pr-check` individually, and never "push now, check later". This applies to
the first push in Stage 8, not only fix-pushes. Before calling the loop done
shipping, run `"$EL" where` to confirm the last clear pass still matches the
branch tip.

Rearm semantics, the no-CI case and what `ship-gate` composes:
`references/operations.md`.

## Run state and resuming a session

**Starting a new session, or returning after a compaction: run `"$EL" where`
before anything else.** Do not re-derive stage or gate state from
conversation history — history can be summarized away, the state file and
live `gh`/JIRA/git facts cannot.

State layout, field meanings and resume behaviour:
`references/operations.md`.

## Replan mode (the spec was wrong)

After GATE 2 the issue body is the source of truth, but the feedback that
invalidates it arrives later — in review, in CI, in a Copilot comment, or
when a seam turns out not to exist as specified.

**The agent decides to enter. The human decides to leave.**

```bash
"$EL" replan start --evidence "<the feedback that invalidated the spec>"
# regenerate behaviour criteria + technical spec + plan TOGETHER
# take the revised plan back through plannotator
"$EL" gate-pass 1 --note "<what was approved>"
"$EL" replan apply --body-file spec.md --subitem "..." --subitem "..."
```

- `start` needs **evidence** — a review thread, a failing run, a tool result.
  "The implementation turned out awkward" is a Stage 5 design discussion, not
  a replan. It re-arms GATE 1, so the plan is formally unapproved.
- **Do not resume Stage 5 coding while a replan is open.** Continuing against
  a spec you have declared wrong is the drift this mode exists to prevent.
- `apply` requires GATE 1 re-approved. It updates the body, reconciles
  sub-issues as a true revision (unchanged stay, additions added, dropped
  ones **closed with the reason**, never deleted), comments on JIRA, and
  bumps the revision counter.
- **`apply` re-arms the ship gate.** The previous clear pass was earned
  against a contract that no longer holds, so `loop ship-gate` must clear
  again before shipping.
- **Then get an independent review with fresh context** — see below.

Full flow, state fields and reconciliation rules:
`references/operations.md`.

## Independent review with fresh context

After the ship gate clears — and always after a replan — dispatch a
read-only reviewer that has **not** seen this session:

```text
subagent(agent: "reviewer", context: "fresh",
         task: "Read the spec and plan in GH issue #<n>, then review the diff
                on this branch against it. Report whether the code matches
                the contract and flag anything it misses. Read-only: do not
                edit files.")
```

Fresh context is the point, not an optimisation. A reviewer carrying this
session's history inherits the assumptions that produced the spec, so it
tends to confirm the design rather than test it. Synthesize the findings in
this session and make the fixes here.

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

- **Read `references/technical-spec.md` first.** It defines the five required
  sections and the self-check that runs before GATE 1.
- Co-develop a _technical_ spec from the product spec (use `ce-plan` thinking)
  with these sections, in this order:
  1. **Architecture decision** — the **seam** added, not just a pattern name.
     State how it composes (wrap, substitute, sequence or inject), how many
     existing call sites change and why, what was rejected, the repo
     convention it matches, and what it makes harder later. The standing
     convention is **additive integration**: extend through clean seams
     without modifying existing call sites, so "call sites touched: 0" is the
     target and any other number needs a reason. Ground the "fits because"
     claim in the codebase, not in taste.
  2. **Data models** — a row per entity touched: `new`/`modified`/`removed`,
     the fields, and the compatibility consequence.
  3. **Interfaces** — a row per caller-visible signature: before, after,
     whether it breaks, and the consumer count.
  4. **Folder structure** — a tree of only the changed paths, each marked
     `NEW`/`MOD`/`DEL`.
  5. **Workflows** — **mermaid `sequenceDiagram`** blocks (they render
     natively in the GitHub issue body — the source of truth). Cover the main
     happy path plus the failure/edge flows the changes above introduce.
- Get the consumer counts and dependency facts from tools, not memory:
  `lsp_navigation` references for call sites, `graphify query "<question>"`
  for cross-module reach (see Stage 3a). Cite what you learned in the spec.
  A breaking change with an unknown blast radius is not specified yet.
- For an unfamiliar system, invoke `/skill:documenting-system-architecture`
  for the wider audit before deciding the pattern.

### Stage 3 — Plannotate the plan

- Turn the tech spec into an execution plan as a Markdown checklist.
- Hand off to **plannotator**: enter plan mode (`/plannotator <plan-file>` or
  `pi --plan`), let the agent call `plannotator_submit_plan`, and iterate on
  the plan in the browser UI until the human **approves**. Approve-with-notes
  and deny-with-annotations both feed structured feedback back here.
- Run `"$EL" analyze` before asking for approval. It checks the spec
  sections, that behaviour criteria and plan items are checkable, that
  interface rows carry a consumer count, and that the plan matches the
  live sub-issues. It **reports only** — it never edits the spec.
- **GATE 1**: do not leave this stage until the plan is human-approved,
  then record it: `"$EL" gate-pass 1 --note "<what was approved>"`.

### Stage 3a — graphify as the LLM wiki (as needed, keep it fresh)

- If `graphify-out/graph.json` exists, answer dependency questions with
  `graphify query "<question>"` (fast path — no rebuild).
- After the change lands (Stage 5+), refresh it: `/graphify <path> --update`
  so the wiki stays current. Treat graphify as living documentation of
  dependencies, updated in the same loop that changes them.

### Stage 4 — Create the tracked issue + JIRA mirror (GATE 2)

The **GitHub issue body is the source of truth**. Build it as:

````text
## Product spec
<functional + non-functional -- simple-english compliant, carried from Stage 1>
## Behaviour criteria
- [ ] Given ... When ... Then ...
## Technical spec
### Architecture decision
<seam added | composes by | call sites touched | rejected | fits because
(cited) | costs>
### Data models
| Entity | Change | Fields | Compatibility |
### Interfaces
| Interface | Before | After | Breaking | Consumers |
### Folder structure
<tree of changed paths only, each marked NEW/MOD/DEL>
### Workflows
<```mermaid sequenceDiagram ...```>
## Plan
- [ ] work item 1
- [ ] work item 2
````

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
- **Immediately run `"$EL" ship-gate`.** This first push gets the same
  wait-for-CI-and-review treatment as every push after it (see "The ship
  gate" above) — do not wait until Stage 9 to run it for the first time.
- Wait for **Copilot** review, then address its comments (see
  `ce-resolve-pr-feedback`). **Push fixes, then immediately run `"$EL"
  ship-gate` again** — a push always rearms it; push and ship-gate are one
  action here, not a step to come back to later.

### Stage 9 — Converge the ship gate

Stage 8 already ran `ship-gate` after every push. This stage is the final
checkpoint — confirm it is clear on the current commit before calling the
loop done shipping, not a first-time run:

```bash
"$EL" ship-gate         # ci-watch + pr-check, one call, one exit code
```

- If it fails, the output says which side(s) failed (CI's failing-job tail,
  and/or pr-check's outstanding-thread summary). Fix, push, and run
  `ship-gate` again immediately — not after doing something else first.
- The loop is only done shipping once one `ship-gate` pass exits 0 **and**
  `"$EL" where` reports no drift for the ship-gate line — that confirms the
  passing commit is still the branch tip, not a stale pass from an earlier
  push (see "Run state and resuming a session").

### Stage 10 — Close out traceability

- Tick the remaining behaviour-criteria checkboxes in the issue.
- After merge, run `"$EL" sync auto-status --jira "$JIRA" --pr "$PR"` once
  more — it reads the merged state and lands on **Done** (no approval gate,
  but this call is what actually performs the transition; see "Automatic
  status sync").

## Pitfalls

Hard rules. Enforced by the scripts where noted, not only remembered.

- **Never** run a `sync` **create/mutate** subcommand before GATE 2 approval
  — enforced by `require_gate 2`, and do not set `LOOP_SKIP_GATE_CHECK=1` on
  a real run.
- **Never** guess the epic — always `find-epic` and confirm with the human.
- **Never** treat a push as clearing only the check it was meant to fix.
  Every push gets a full `ship-gate`.
- **Never** skip the `simple-english` pass on the Stage 1 product spec — the
  Stage 4 issue body inherits that section verbatim.
- **Never** assert a consumer count, or that "the repo already does it this
  way", from memory. Check with `lsp_navigation` and `graphify`.
- **A technical spec of prose and one diagram cannot be refined.** It needs
  the five sections in `references/technical-spec.md`, and a pattern name is
  not an architecture decision — the seam, how it composes, and the call
  sites it forces are.
- Integration tests must use real collaborators; a mock defeats Stage 7.
- Keep `.loop/` gitignored (setup does this).
- Dispatching `ce-work`/`ce-code-review` to a subagent still leaves gate
  enforcement with this session.

Platform quirks and failure modes behind these: `references/pitfalls.md`.

## Verification

A completed run leaves: a GH issue (spec source of truth) with sub-issues, a
mirrored JIRA story/sub-tasks under the confirmed epic, cross-links both
ways, a merged PR closing the issue, and green CI.

The Stage 2 spec carries all five sections from
`references/technical-spec.md`, names the seam it adds, and states the count
of existing call sites it changes.

Per-command checks: `references/operations.md`.
