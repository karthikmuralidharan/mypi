# Skill-trigger eval

Measures whether pi loads the **right** skill for a request — and, just as
importantly, whether it loads **nothing** when no skill applies.

Why this target, and not "make the harness cheaper": the
[claude-api hillclimb guidance](https://claude.dev/blog/automating-eval-design-and-hillclimbing/)
warns that open-ended harness changes stall, and that the successful cases
couple a metric tightly to one cheap text surface. Skill triggering does that:
the metric is trigger accuracy, the surface is skill descriptions and
`disable-model-invocation` flags.

It also answers a question we could not settle by argument: whether hiding 27
package skills from the catalogue costs anything real.

## The surface under test

| Will change | Won't touch |
| --- | --- |
| `description` fields in `SKILL.md` frontmatter | skill bodies |
| `disable-model-invocation` flags | `config/models.json`, model choice |
| `settings.json` `skills` entries | `config/mcp.json`, MCP exposure |
| `config/AGENTS.md` routing text | `~/.pi/agent/git/` directly |

## Hard gates before round 1

Both come from the claude-api guidance and neither is optional.

**Step 0 — can the eval see the win?** `bin/report.py --gates` prints three
numbers: the **noise floor** (paired-difference CI half-width at the current
cases × reps), the **headroom** (ceiling minus baseline), and the **smallest
improvement you would act on**. If the noise floor exceeds either of the others,
stop and add reps or cases. Do not start the loop.

This session already produced a worked example of ignoring that rule: the whole
system-prompt diet moved real cost by about 5%, which is inside the noise.

**Step 0 — is the mechanism wired?** `bin/eval.sh --probe` confirms a known
skill can actually be triggered end-to-end in an isolated agent directory. If
that fails, every score is meaningless.

**Step 0.5 — train/test split.** `split` in `cases.jsonl` is drawn at random,
stratified by `tags[0]`, **never by baseline score**. The analyzer reads *train*
transcripts only. *Test* is scored every round, never opened, and provides the
headline.

> With fewer than ~20 cases a split is too small to carry a headline. At the
> current count, treat per-round scores as **directional** — an iterate-on
> number, not a publish number. Add cases before claiming a result.

## Running it

```bash
bin/eval.sh --probe                     # Step 0: mechanism wired?
bin/eval.sh --reps 3 --out runs/base    # baseline
bin/report.py runs/base --gates         # Step 0 numbers
bin/report.py runs/base                 # headline, recomputed from raw rows
```

Each case is one `pi -p` run in a throwaway `PI_CODING_AGENT_DIR`, so candidates
cannot contaminate each other and no run touches your live config.

**Cost warning.** One round is `cases × reps` real model calls. 16 × 3 = 48 runs.
Budget accordingly, and keep the model identical to production — a cheaper model
would break "tasks mirror production".

## Scoring

Per case, the grader reads the session JSONL and records which skills were
loaded, by either path:

- a `<skill name="X">` block (explicit `/skill:X`)
- a read of `.../X/SKILL.md` (model-triggered)

| Expected | Loaded | Verdict |
| --- | --- | --- |
| skill `X` | `X` present | hit |
| skill `X` | something else, or nothing | miss |
| `null` | nothing | correct abstain |
| `null` | anything | **false trigger** |

False triggers are the cost side of advertising a skill. An eval with only
positive cases would reward triggering everything, so roughly a third of the
cases expect `null`.

Headline metric is **balanced accuracy** across the two case classes, so adding
positive cases cannot drown out the abstain cases.

## Autoresearch wiring

`pi-autoresearch` has no notion of a held-out set, so the split maps onto its
two existing hooks:

| autoresearch hook | here | scope |
| --- | --- | --- |
| `.auto/measure.sh` | `measure.sh` | train accuracy |
| `.auto/checks.sh` | `checks.sh` | held-out gate |

`checks.sh` exits non-zero if the test split regresses, which makes
autoresearch auto-revert the change.

That gives the "keep only if it holds on test" rule without modifying
autoresearch.

## Pitfalls this layout guards against

- **Ground truth reachable.** Cases carry no answer key on disk inside the
  working directory the agent sees; expectations live only in `cases.jsonl`,
  outside the sandbox cwd.
- **Leftover state.** Every run gets a fresh agent dir and a fresh temp cwd.
- **Grader instability.** The grader is programmatic, so running it twice on the
  same transcript gives the same verdict by construction.
- **Infrastructure noise read as model variance.** `results.jsonl` records
  `error` and `timed_out` per row; `report.py` reports them separately rather
  than scoring them as misses.
