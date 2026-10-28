# Operations detail

Mechanism, state layout and per-command checks. The hard rules stay in
`SKILL.md`; this is the material you only need when something is wrong or
when resuming.

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

**Push and `ship-gate` are one action, not two steps to remember
separately.** Every push in Stage 8 (the first one and every fix after it)
is immediately followed by `"$EL" ship-gate` — do not push, move on to
something else, and come back to it later. `ci-watch` treats a repo with no
CI configured as clear rather than failing on it (checked directly against
a real no-CI repo), so it is always safe to run right after the first push,
before any check could plausibly exist yet.

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

## Verification

- The Stage 2 spec carries all five sections from
  `references/technical-spec.md`, names the seam it adds, and states the
  count of existing call sites it changes.
- Every interface row has a consumer count obtained from a tool, and every
  data-model row states whether it is breaking.
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

## Replan mode in detail

`SKILL.md` carries the rules. This is the mechanism.

### Why entry is cheap and exit is gated

If the agent could both declare the spec wrong and ratify its replacement,
the cheapest way to make failing work pass would be to rewrite the spec to
match the code, and the issue would stop being a contract. So `start` is free
and `apply` requires `require_gate 1` — which only succeeds after a human has
run `gate-pass 1` on the revised plan.

GitHub's Spec Kit reaches the same conclusion from the other direction: its
`analyze` reports inconsistencies without editing, and its `converge` is
append-only, specifically so implementation cannot silently rewrite intent.

### State fields

| Field | Meaning |
| --- | --- |
| `revision` | count of applied revisions; 0 before the first |
| `replan.open` | true between `start` and `apply` |
| `replan.evidence` | the feedback that justified the revision |
| `replan.sections` | optional hint of which sections are affected |
| `gate1.approved` | set false by `start`, true again by `gate-pass 1` |
| `lastShipGatePassCommit` | cleared by `apply` — see below |

### Sub-issue reconciliation

`apply` compares the `--subitem` titles against the live sub-issue set read
from GitHub, not from state, for the same reason `where` trusts live facts:

- title in both -> **kept**, with its history and comments intact
- title only in the revised plan -> **added**, plus a mirrored JIRA sub-task
- open sub-issue no longer in the plan -> **closed** with the evidence as a
  comment, and its JIRA sub-task moved to Done

Nothing is deleted or unlinked. A dropped plan item stays reachable from the
parent issue.

### Why `apply` re-arms the ship gate

`ship-gate` records the commit it passed against, so `where` can distinguish
"still on the passing commit" from "pushed since". A revision means that pass
was earned against a contract that no longer holds, so `apply` clears
`lastShipGatePassCommit` and the gate must be re-earned. `replan status`
exits non-zero while a revision exists with no re-earned pass.

### Known limitation

`apply` **replaces** the issue body. The previous spec is recoverable only
from the GitHub edit history, not from the issue itself. An append-only
`## Revision N` block, or storing deltas and merging them the way OpenSpec
does, would keep the original intent visible in the body. Worth revisiting.

## `loop analyze` — consistency, reported not fixed

Reports; never edits. Spec Kit's `analyze` works the same way, so that a
finding cannot be "resolved" by quietly rewriting intent. Reads the live
issue body, so it also catches an issue that has drifted from the branch.

| Check | Severity | Looks for |
| --- | --- | --- |
| `sections` | error | the four top-level sections |
| `spec-sections` | error | the five technical-spec subsections |
| `behaviours` | error/warn | `- [ ]` criteria; Given/When/Then shape |
| `plan` | error | `- [ ]` work items |
| `workflows` | error | a ```` ```mermaid ```` block |
| `interfaces` | error/warn | 5 columns, and a non-empty consumer count |
| `data-models` | error | every row marked new/modified/removed |
| `folders` | warn | NEW/MOD/DEL markers in the tree |
| `plan-subissues` | error/warn | plan items and open sub-issues agree |
| `traceability` | warn | a `JIRA: <KEY>` marker |

Exit 0 when there are no errors, 1 when there are, 2 when it cannot run.
Warnings never fail the command. `--json` gives
`{issue, errors, warnings, findings[]}` for an agent to consume.

`plan-subissues` is the one that earns its keep: an open sub-issue missing
from the plan is an **error**, because it means work is tracked that the
approved plan does not describe. That is the drift replan exists to correct,
and it is cheaper to catch here.

If a finding means the contract itself is wrong, that is a replan, not an
edit.
