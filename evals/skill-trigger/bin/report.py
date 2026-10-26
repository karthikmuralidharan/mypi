#!/usr/bin/env python3
"""Score a skill-trigger run, with the claude-api Step 0 / Step 0.5 gates.

  bin/report.py runs/base --gates        # can the eval see the win?
  bin/report.py runs/base                # headline, recomputed from raw rows
  bin/report.py runs/base runs/cand      # paired difference, test split only

Headline is balanced accuracy: the mean of the positive-class and abstain-class
accuracies, so adding positive cases cannot drown out the abstain cases.
Errors and timeouts are reported separately, never scored as misses -- that is
how infrastructure noise gets mistaken for model variance.
"""
import argparse
import json
import random
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPLIT_FILE = ROOT / "split.json"
BOOTSTRAP = 2000


def load(run: Path) -> list[dict]:
    f = run / "results.jsonl"
    try:
        raw = f.read_text()
    except OSError as e:
        print(f"cannot read {f}: {e}", file=sys.stderr)
        sys.exit(2)
    rows = []
    for n, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as e:
            print(f"{f}:{n}: bad JSON: {e}", file=sys.stderr)
            sys.exit(2)
    return rows


def draw_split(rows: list[dict], seed: int = 1729) -> dict:
    """Random, stratified by tags[0]. Never by score -- that is the whole point."""
    if SPLIT_FILE.exists():
        try:
            return json.loads(SPLIT_FILE.read_text())
        except (OSError, json.JSONDecodeError) as e:
            print(f"cannot read split file {SPLIT_FILE}: {e}", file=sys.stderr)
            print("delete it to redraw the split", file=sys.stderr)
            sys.exit(2)
    by_stratum = defaultdict(list)
    for cid, tags in {r["case"]: r.get("tags") or ["untagged"] for r in rows}.items():
        by_stratum[tags[0]].append(cid)
    rng = random.Random(seed)
    split = {}
    for _stratum, ids in sorted(by_stratum.items()):
        ids = sorted(ids)
        rng.shuffle(ids)
        half = len(ids) // 2
        for i, cid in enumerate(ids):
            split[cid] = "train" if i < half else "test"
    SPLIT_FILE.write_text(json.dumps(
        {"seed": seed, "note": "stratified by tags[0]; regenerate by deleting this file",
         "split": split}, indent=2) + "\n")
    return {"seed": seed, "split": split}


def per_case(rows: list[dict]) -> tuple[dict, dict]:
    """case -> mean correctness over clean reps; plus infra counters."""
    acc, infra = defaultdict(list), {"errors": 0, "timeouts": 0, "clean": 0}
    for r in rows:
        if r.get("timed_out"):
            infra["timeouts"] += 1
            continue
        if r.get("error"):
            infra["errors"] += 1
            continue
        infra["clean"] += 1
        acc[r["case"]].append(1.0 if r.get("correct") else 0.0)
    return {k: statistics.fmean(v) for k, v in acc.items() if v}, infra


def balanced(scores: dict, expects: dict) -> tuple[float, float, float]:
    pos = [v for k, v in scores.items() if expects.get(k) is not None]
    abst = [v for k, v in scores.items() if expects.get(k) is None]
    p = statistics.fmean(pos) if pos else float("nan")
    a = statistics.fmean(abst) if abst else float("nan")
    both = [x for x in (p, a) if x == x]
    return (statistics.fmean(both) if both else float("nan")), p, a


def boot_halfwidth(scores: dict, expects: dict, seed: int = 7) -> float:
    """Bootstrap 95% CI half-width on balanced accuracy = the noise floor."""
    pos = [v for k, v in scores.items() if expects.get(k) is not None]
    abst = [v for k, v in scores.items() if expects.get(k) is None]
    if not pos or not abst:
        return float("nan")
    rng = random.Random(seed)
    draws = []
    for _ in range(BOOTSTRAP):
        p = statistics.fmean(rng.choices(pos, k=len(pos)))
        a = statistics.fmean(rng.choices(abst, k=len(abst)))
        draws.append((p + a) / 2)
    draws.sort()
    lo, hi = draws[int(0.025 * BOOTSTRAP)], draws[int(0.975 * BOOTSTRAP)]
    return (hi - lo) / 2


def section(rows, split, which, expects):
    sel = [r for r in rows if split["split"].get(r["case"]) == which] if which else rows
    scores, infra = per_case(sel)
    bal, p, a = balanced(scores, expects)
    return scores, infra, bal, p, a


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--gates", action="store_true")
    ap.add_argument("--mde", type=float, default=0.05,
                    help="smallest improvement you would act on")
    a = ap.parse_args()

    base_rows = load(Path(a.runs[0]))
    expects = {r["case"]: r.get("expect") for r in base_rows}
    split = draw_split(base_rows)

    scores, infra, bal, p, abs_acc = section(base_rows, split, None, expects)
    print(f"== {a.runs[0]} ==")
    print(f"  cases {len(scores)}  clean runs {infra['clean']}  "
          f"errors {infra['errors']}  timeouts {infra['timeouts']}")
    print(f"  balanced accuracy {bal:.3f}   positive {p:.3f}   abstain {abs_acc:.3f}")
    for which in ("train", "test"):
        _, _, b, pp, aa = section(base_rows, split, which, expects)
        n = sum(1 for c in scores if split["split"].get(c) == which)
        print(f"  {which:<5} n={n:<3} balanced {b:.3f}  positive {pp:.3f}  abstain {aa:.3f}")

    worst = sorted(scores.items(), key=lambda kv: kv[1])[:6]
    print("\n  lowest-scoring cases (read these, not the test ones):")
    for cid, sc in worst:
        exp = expects.get(cid)
        print(f"    {cid:<10} {sc:.2f}  expect={exp or 'null'}  "
              f"[{split['split'].get(cid)}]")

    if a.gates:
        nf = boot_halfwidth(scores, expects)
        headroom = 1.0 - bal
        print("\n== Step 0 gates ==")
        print(f"  noise floor (95% CI half-width) : {nf:.3f}")
        print(f"  headroom (1.0 - baseline)       : {headroom:.3f}")
        print(f"  smallest delta you would act on : {a.mde:.3f}")
        blocked = [n for n, v in (("headroom", headroom), ("your MDE", a.mde))
                   if nf > v]
        if blocked:
            print(f"\n  STOP: noise floor exceeds {' and '.join(blocked)}.")
            print("  The loop cannot show a real win no matter how good the")
            print("  changes are. Add reps or cases, or pick a finer metric.")
            return 1
        print("\n  OK: the eval can see a win of your stated size.")
        if bal > 0.95:
            print("  NOTE: baseline above 0.95 -- little quality headroom.")
            print("  Point the hillclimb at cost or latency instead.")

    if len(a.runs) > 1:
        cand_rows = load(Path(a.runs[1]))
        cs, ci, cb, cp, ca = section(cand_rows, split, "test", expects)
        _, _, bb, _, _ = section(base_rows, split, "test", expects)
        print(f"\n== held-out delta: {a.runs[1]} vs {a.runs[0]} ==")
        print(f"  test balanced accuracy {bb:.3f} -> {cb:.3f}  "
              f"delta {cb - bb:+.3f}")
        print(f"  candidate errors {ci['errors']}  timeouts {ci['timeouts']}")
        nf = boot_halfwidth(cs, expects)
        verdict = "KEEP" if (cb - bb) > nf else "REVERT (inside noise)"
        print(f"  noise floor {nf:.3f}  ->  {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
