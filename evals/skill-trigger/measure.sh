#!/usr/bin/env bash
# autoresearch TRAIN metric. Scores the train split only and emits METRIC
# lines for `run_experiment`. The analyzer may read these transcripts.
#
# The held-out split is deliberately NOT scored here -- that is checks.sh,
# which autoresearch treats as a correctness gate and auto-reverts on.
set -euo pipefail

cd "$(dirname "$0")"
REPS="${SKILL_EVAL_REPS:-3}"
OUT="runs/train-$(date +%Y%m%dT%H%M%S)"

if [[ ! -f split.json ]]; then
  echo "no split.json yet — run a baseline first:" >&2
  echo "  bin/eval.py --reps $REPS --out runs/baseline" >&2
  echo "  bin/report.py runs/baseline --gates" >&2
  exit 2
fi

ids="$(python3 -c '
import json,sys
s=json.load(open("split.json"))["split"]
print(",".join(sorted(k for k,v in s.items() if v=="train")))
')"

if [[ -z "$ids" ]]; then
  echo "train split is empty — delete split.json and redraw" >&2
  exit 2
fi

bin/eval.py --only "$ids" --reps "$REPS" --out "$OUT" >&2

python3 - "$OUT" <<'PY'
import json, statistics, sys
from collections import defaultdict
rows = [json.loads(l) for l in open(sys.argv[1] + "/results.jsonl") if l.strip()]
acc = defaultdict(list)
infra = 0
exp = {}
for r in rows:
    if r.get("error") or r.get("timed_out"):
        infra += 1
        continue
    exp[r["case"]] = r.get("expect")
    acc[r["case"]].append(1.0 if r.get("correct") else 0.0)
sc = {k: statistics.fmean(v) for k, v in acc.items() if v}
pos = [v for k, v in sc.items() if exp.get(k) is not None]
abst = [v for k, v in sc.items() if exp.get(k) is None]
parts = [statistics.fmean(x) for x in (pos, abst) if x]
bal = statistics.fmean(parts) if parts else 0.0
print(f"METRIC balanced_accuracy={bal:.4f}")
if pos:
    print(f"METRIC positive_accuracy={statistics.fmean(pos):.4f}")
if abst:
    print(f"METRIC abstain_accuracy={statistics.fmean(abst):.4f}")
print(f"METRIC infra_failures={infra}")
print(f"METRIC cost_usd={sum(r.get('cost', 0) or 0 for r in rows):.4f}")
print(f"METRIC tokens={sum(r.get('tokens', 0) or 0 for r in rows)}")
PY
