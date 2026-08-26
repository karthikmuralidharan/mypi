---
name: ce-rigor
description: "Enforce superpowers-grade execution discipline as BLOCKING gates during implementation -- the TDD Iron Law (RED, watch it fail, GREEN, REFACTOR) and a per-unit two-stage review loop (spec compliance, then code quality). Use while executing a plan unit in ce-work or lfg for any feature-bearing or test-first unit, or whenever the user asks for strict TDD, test-first, characterization-first, or 'rigorous' execution. This is the rigor layer compound engineering leaves optional."
argument-hint: "[unit goal + test scenarios, or path to the plan unit being executed; blank to apply to the current in-progress unit]"
---

# ce-rigor — Execution Discipline Overlay

This skill is an **overlay**, not a standalone workflow. It is invoked by `ce-work` (Phase 2) or `lfg` while a single implementation unit is being built, and it supplies the two enforcement primitives that compound engineering intentionally leaves loose:

1. **The TDD Iron Law** — RED → *watch it fail* → GREEN → REFACTOR, mandatory per behavior.
2. **The two-stage blocking review loop** — spec compliance, then code quality, each looping until ✅ *before the unit is marked complete*.

`ce-plan` defines WHAT/HOW. `ce-work` executes. **`ce-rigor` is the gate that decides when a unit is actually done.** It does not plan, scope, or ship — it governs the inner execution loop of one unit.

> **Type: Rigid.** Follow these gates exactly. Do not adapt away the discipline. Violating the letter of the rules is violating the spirit of the rules.

---

## Unit of Work

<unit_context> #$ARGUMENTS </unit_context>

If `<unit_context>` is empty, apply these gates to the implementation unit currently marked in-progress in the task tracker. Pull its Goal, Files, Approach, and Test scenarios from the plan (or from the bare-prompt discovery `ce-work` already performed).

---

## Instruction Priority

User instructions always win. If the user, `AGENTS.md`, or `CLAUDE.md` says "don't use TDD" or "skip tests here," follow that and skip this overlay for the affected unit. Otherwise, when this skill is invoked for a unit, its gates are **blocking** — the unit is not complete until every gate clears.

---

## When to Use / When to Skip

**Use (gates are blocking):**
- The unit is feature-bearing (adds or changes behavior).
- The unit carries `Execution note: test-first` or `characterization-first`.
- The user asked for strict TDD, test-first, or "rigorous"/"disciplined" execution this session.
- Bug fixes (write the failing test that reproduces the bug first).

**Skip (proceed without these gates):**
- Pure config, scaffolding, copy, or styling with no behavioral change.
- Trivial renames or mechanical refactors with existing green coverage.
- Throwaway prototypes or generated code (confirm with the user if unsure).

Thinking "skip the gate just this once" on a behavior-bearing unit? That is the rationalization this overlay exists to stop. See the table below.

---

## Setup — Turn Gates Into Todos

Before touching code for the unit, create one task-tracker item per gate so the discipline is visible and cannot be silently skipped:

- [ ] RED: failing test written for the next behavior
- [ ] Verify RED: watched it fail for the *expected* reason
- [ ] GREEN: minimal code makes it pass; full suite still green
- [ ] REFACTOR: cleaned up, stayed green
- [ ] (repeat RED→GREEN for each behavior in the unit's test scenarios)
- [ ] Spec-compliance review: ✅ (no missing requirements, nothing extra)
- [ ] Code-quality review: ✅

Mark each complete only when its evidence exists (a failing test you saw fail; a passing suite; a clean review).

---

## Gate 1 — The TDD Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote implementation before the test? **Delete it and start over from the test.** Don't keep it "as reference," don't "adapt" it — implement fresh from the test. The cycle, per behavior in the unit's test scenarios:

### RED — write one failing test

- One behavior, clear name, real code (mocks only when genuinely unavoidable).
- Derive it from the unit's enumerated Test scenarios. If a scenario category that applies (happy path / edge / error / integration) is missing, add it before writing code — do not invent thin coverage.

### Verify RED — watch it fail (MANDATORY, never skip)

- Run the test. Confirm it **fails** (not errors) and fails for the **expected reason** (feature missing), not a typo or import error.
- **If it passes immediately:** you are testing existing behavior — the test is wrong. Fix the test.
- **Core principle:** *If you didn't watch the test fail, you don't know that it tests the right thing.* This single step is what separates "tests exist" from TDD. It is the step compound engineering omits — do not omit it here.

### GREEN — minimal code to pass

- Write the simplest code that makes the test pass. No extra options, flags, or "while I'm here" features (YAGNI).

### Verify GREEN — watch it pass

- The new test passes, the **whole relevant suite stays green**, and output is pristine (no new warnings/errors). If other tests broke, fix the code now — not the tests.

### REFACTOR — clean up while green

- Remove duplication, improve names, extract helpers. Keep tests green. Add no new behavior.

Repeat RED→GREEN→REFACTOR for the next behavior until the unit's scenarios are covered.

**Characterization-first units:** the same loop, but the first RED test *captures existing behavior* before you change it. Pin the current output, see it pass, then drive new behavior test-first.

---

## Gate 2 — Two-Stage Blocking Review Loop

After Gate 1 is green for the whole unit, the unit is **still not complete**. Run two reviews, in this order, each looping until it returns ✅. Spec compliance **first** — a well-built thing that builds the wrong scope is still wrong.

Prefer dispatching each review to a **fresh subagent** (via the `subagent` tool / `pi-subagents`) so the reviewer has clean context and no authorship bias. Give the reviewer the unit's spec (Goal, Requirements, Test scenarios, Verification) and the diff/SHAs — not your session history. If subagents are unavailable, perform the review yourself but treat the findings as blocking.

### Stage A — Spec compliance

Reviewer answers: does the diff implement exactly the unit's spec — nothing missing, nothing extra?
- **Issues found → fix → re-review.** Repeat until ✅. Do not proceed to Stage B with open spec issues.
- "Close enough" is not ✅. Extra unrequested features are a spec failure too (remove them or get them added to scope).

### Stage B — Code quality

Only after Stage A is ✅. Reviewer checks: clarity, duplication, naming, error handling, the System-Wide Test Check (callbacks/middleware/state two levels out), and whether at least one integration test exercises the real chain (not all-mocks).
- **Issues found → fix → re-review.** Repeat until ✅.

Only when both stages are ✅ do you mark the unit's task complete and let `ce-work` evaluate the incremental commit.

---

## Anti-Rationalization Table

These thoughts mean **STOP — you are rationalizing your way out of the gate**:

| Thought | Reality |
|---|---|
| "Too simple to test" | Simple code breaks. The test takes 30 seconds. |
| "I'll write the test after" | Tests written after pass immediately and prove nothing. |
| "Tests-after achieve the same goal" | Tests-after ask "what does this do?" Tests-first ask "what *should* it do?" |
| "I already manually tested it" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting this code I wrote first is wasteful" | Sunk cost. Keeping unverified code is the debt. Delete, redo test-first. |
| "Keep it as reference while I write the test" | You'll adapt it — that's testing after. Delete means delete. |
| "The spec reviewer is overkill for this unit" | Scope drift is silent and cheap to catch now, expensive later. |
| "Skip re-review, my fix is obviously right" | Re-review is the only proof the fix actually closed the finding. |
| "I'll batch the review at the end" | Post-hoc review is what we are replacing. Gate per unit. |
| "This unit is different because…" | If it's behavior-bearing, the gate applies. |

Any of these → return to the gate.

---

## Completion Checklist (per unit)

Do not mark the unit complete unless every box is true:

- [ ] Each new behavior had a test written **first**.
- [ ] You **watched each test fail** for the expected reason before implementing.
- [ ] Minimal code made each test pass; the relevant suite is fully green with pristine output.
- [ ] Refactor left tests green and added no behavior.
- [ ] At least one integration test exercises the real chain where the unit crosses layers.
- [ ] Stage A spec-compliance review returned ✅ (loop closed).
- [ ] Stage B code-quality review returned ✅ (loop closed).

Can't check them all? You skipped a gate. Close it before continuing.

---

## Integration

- **Invoked by `ce-work`** (Phase 2 execution loop) for each test-first or feature-bearing unit, and by **`lfg`** during its work step.
- **Returns control to `ce-work`** once the unit's checklist is satisfied — `ce-work` owns task-tracker updates, incremental commits, and the System-Wide simplify pass across units.
- **Does not** create branches, push, open PRs, or run the shipping workflow — those stay with `ce-work` Phase 3-4 / `ce-commit-push-pr` / `lfg`.
- **Strict-mode toggle:** if the user says "strict mode," "rigorous," or "TDD everything" for the session, treat *every* feature-bearing unit as in-scope for these gates even when the plan carries no `Execution note`.
