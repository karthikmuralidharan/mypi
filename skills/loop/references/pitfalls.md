# Pitfalls in detail

The hard rules are in `SKILL.md`. These are the platform quirks, failure
modes and hard-won details behind them.

- **Never** run a `sync` **create/mutate** subcommand (`create-issue`,
  `mirror-jira`, `add-subissue`, `mirror-subtask`, `link`, `bootstrap`)
  before GATE 2 approval. This is enforced (`require_gate 2` dies with a
  clear message), not only a rule to remember — but `LOOP_SKIP_GATE_CHECK=1`
  can bypass it, so do not set that variable during a real run. `sync
  status`/`sync auto-status` are exempt once the ticket is confirmed.
- **Never** guess the epic — always `find-epic` and confirm.
- **Never** treat a push as clearing only the check it was meant to fix. A
  CI-only fix can still be sitting on stale/unresolved review threads; a
  review-only fix still needs a fresh CI run. **Every push gets an
  immediate `"$EL" ship-gate` call** (never `ci-watch`/`pr-check`
  individually, and never "push now, check later") — this applies to the
  first push in Stage 8 too, not only fix-pushes. Before calling the loop
  done shipping, also run `"$EL" where` to confirm the last clear pass still
  matches the branch tip.
- A repo with no CI configured is common, not an error — `ci-watch` detects
  "no checks reported" and treats it as clear rather than failing (fixed
  and verified directly against a real no-CI repo; earlier it reported a
  false CI failure indistinguishable from a real one).
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
- **A technical spec of prose and one diagram cannot be refined.** Reviewers
  can argue with it but not correct it, because nothing in it is a concrete
  delta. If the data-model, interface and folder sections are missing, the
  spec is not ready for GATE 1 — the folder tree in particular is where a
  contradiction between the named seam and the actual layout becomes
  visible, and it shows up nowhere else.
- **A pattern name is not an architecture decision.** "Uses ports and
  adapters" says nothing a reviewer can correct. The seam, how it composes,
  and the count of call sites it forces are the decision. A design that
  cannot take a second variant without editing the first is not composable,
  whatever it is called.
- **Never** assert a consumer count or "the repo already does it this way"
  from memory. Both are checkable with `lsp_navigation` and `graphify`, so
  check them; an unverified blast radius is the most expensive thing to get
  wrong at Stage 5.
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
