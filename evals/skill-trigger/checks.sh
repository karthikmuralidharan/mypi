#!/usr/bin/env bash
# autoresearch HELD-OUT gate.
#
# autoresearch treats a non-zero exit from checks.sh as "checks_failed" and
# auto-reverts the change. That is exactly the rule the claude-api hillclimb
# guidance wants: keep a change only if it holds on the held-out split.
#
# The analyzer must never read these transcripts. This script prints scores
# only -- no case content, no transcript paths.
set -euo pipefail

cd "$(dirname "$0")"
REPS="${SKILL_EVAL_REPS:-3}"
BASELINE="${SKILL_EVAL_BASELINE:-runs/baseline}"
OUT="runs/test-$(date +%Y%m%dT%H%M%S)"

if [[ ! -f split.json ]]; then
  echo "no split.json — run a baseline first" >&2
  exit 2
fi
if [[ ! -f "$BASELINE/results.jsonl" ]]; then
  echo "no baseline at $BASELINE — nothing to compare against" >&2
  exit 2
fi

ids="$(python3 -c '
import json
s = json.load(open("split.json"))["split"]
print(",".join(sorted(k for k, v in s.items() if v == "test")))
')"

if [[ -z "$ids" ]]; then
  echo "test split is empty — delete split.json and redraw" >&2
  exit 2
fi

bin/eval.py --only "$ids" --reps "$REPS" --out "$OUT" >&2

python3 - "$BASELINE" "$OUT" <<'PY'
import json, statistics, sys
from collections import defaultdict


def balanced(path, only=None):
    rows = [json.loads(l) for l in open(path + "/results.jsonl") if l.strip()]
    acc, exp, infra = defaultdict(list), {}, 0
    for r in rows:
        if only and r["case"] not in only:
            continue
        if r.get("error") or r.get("timed_out"):
            infra += 1
            continue
        exp[r["case"]] = r.get("expect")
        acc[r["case"]].append(1.0 if r.get("correct") else 0.0)
    sc = {k: statistics.fmean(v) for k, v in acc.items() if v}
    pos = [v for k, v in sc.items() if exp.get(k) is not None]
    abst = [v for k, v in sc.items() if exp.get(k) is None]
    parts = [statistics.fmean(x) for x in (pos, abst) if x]
    return (statistics.fmean(parts) if parts else 0.0), infra, set(sc)


base_path, cand_path = sys.argv[1], sys.argv[2]
cand, cand_infra, cases = balanced(cand_path)
base, _, _ = balanced(base_path, only=cases)
delta = cand - base
# Tolerance: a regression must clear this to count as real. Keep it in step
# with the noise floor that report.py --gates prints.
tol = float(__import__("os").environ.get("SKILL_EVAL_TOL", "0.05"))

print(f"held-out balanced accuracy: {base:.3f} -> {cand:.3f} ({delta:+.3f})")
print(f"infra failures in candidate: {cand_infra}")
if cand_infra > len(cases):
    print("FAIL: more infra failures than cases — treat as broken, not worse")
    raise SystemExit(1)
if delta < -tol:
    print(f"FAIL: held-out regression beyond tolerance {tol:.3f}")
    raise SystemExit(1)
print("PASS: held-out set did not regress")
PY
