#!/usr/bin/env python3
"""Run the skill-trigger eval.

One `pi -p` run per (case, rep) in a throwaway PI_CODING_AGENT_DIR and a
throwaway fixture repo, so no run can see another run's state or your live
config. Emits one JSON row per run to <out>/results.jsonl.

  bin/eval.py --probe                    # Step 0: is the mechanism wired?
  bin/eval.py --reps 3 --out runs/base   # baseline
  bin/eval.py --only loop-01 --reps 1    # single case, for debugging
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIVE = Path(os.environ.get("PI_LIVE_AGENT_DIR", Path.home() / ".pi/agent"))

# Copied per run (small, and what a candidate patches).
COPY_FILES = ["settings.json", "models.json", "AGENTS.md"]
COPY_DIRS = ["skills"]
# Symlinked: heavy, read-only, identical across candidates.
LINK = ["npm", "git", "install", "auth.json", "models-store.json"]


def build_agent_dir(dst: Path, candidate: Path | None) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for f in COPY_FILES:
        if (LIVE / f).exists():
            shutil.copy2(LIVE / f, dst / f)
    for d in COPY_DIRS:
        if (LIVE / d).is_dir():
            shutil.copytree(LIVE / d, dst / d, symlinks=True, dirs_exist_ok=True)
    for name in LINK:
        src = LIVE / name
        if src.exists() and not (dst / name).exists():
            (dst / name).symlink_to(src)

    # MCP off: at `deferred` exposure its tools are not in the prompt, so it
    # cannot affect skill choice, but connecting three servers per run adds
    # latency, cost and a noise source. Deliberate noise reduction.
    (dst / "mcp.json").write_text('{"mcpServers": {}}\n')

    # A candidate is an overlay: same relative paths, copied over the top.
    if candidate:
        base = dst.resolve()
        for p in sorted(candidate.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(candidate)
            target = (dst / rel).resolve()
            if not str(target).startswith(str(base) + os.sep):
                raise ValueError(f"candidate path escapes agent dir: {rel}")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)


FIXTURE = {
    "go.mod": "module example.com/signals\n\ngo 1.24\n",
    "internal/resolver/dial.go": (
        "package resolver\n\n"
        "type Opts struct{ Target string }\n\n"
        "func ResolveTarget(opts *Opts) string {\n\treturn opts.Target\n}\n\n"
        "var cfg = Opts{Target: \"localhost:0\"}\n"
    ),
    "cmd/server/main.go": (
        "package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n)\n\n"
        "func main() { fmt.Println(\"up\") }\n"
    ),
    "config.go": "package signals\n\nconst Timeout = \"30s\"\n",
    "docs/BOUNDARY.md": "# Boundary\n\nThis document delineates tracked vs untracked artefacts.\n",
}


def build_fixture(dst: Path) -> None:
    base = dst.resolve()
    for rel, body in FIXTURE.items():
        # FIXTURE keys are module-level literals, but keep the invariant
        # explicit so a future edit cannot introduce an escaping path.
        p = (dst / rel).resolve()
        if not str(p).startswith(str(base) + os.sep):
            raise ValueError(f"fixture path escapes repo dir: {rel}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    env = {**os.environ, "GIT_AUTHOR_NAME": "eval", "GIT_AUTHOR_EMAIL": "e@x",
           "GIT_COMMITTER_NAME": "eval", "GIT_COMMITTER_EMAIL": "e@x"}
    q = {"cwd": dst, "env": env, "capture_output": True}
    subprocess.run(["git", "init", "-q", "-b", "main"], **q)
    for msg in ["init", "add resolver", "add server",
                "add config", "add docs"]:
        subprocess.run(["git", "add", "-A"], **q)
        subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", msg], **q)


SKILL_BLOCK = re.compile(r'<skill name="([a-z0-9][a-z0-9-]*)"')
SKILL_PATH = re.compile(r'([a-z0-9][a-z0-9-]*)/SKILL\.md')
TOOL_CALL_TYPES = {"toolCall", "tool_use", "toolUse"}


def skills_loaded(agent_dir: Path) -> tuple[list[str], dict]:
    """Which skills the transcript shows being loaded, plus usage totals.

    Only two things count as a load:
      - an assistant tool call whose arguments name a `<skill>/SKILL.md` path
        (the model triggered it), or
      - a `<skill name="X">` block in a user message (an explicit /skill:X).

    The `system` role is skipped deliberately: it carries the skills
    catalogue, which lists every advertised skill's SKILL.md location. Matching
    it would mark every case as loading all 36 skills. The `toolResult` role is
    skipped too, since a file read can echo a catalogue or another SKILL.md.
    """
    loaded: list[str] = []
    usage = {"cost": 0.0, "tokens": 0, "turns": 0}
    for sf in sorted((agent_dir / "sessions").rglob("*.jsonl")):
        for line in sf.read_text(errors="replace").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                if os.environ.get("PI_EVAL_DEBUG"):
                    print(f"  skipped unparsable line in {sf.name}: {e}",
                          file=sys.stderr)
                continue

            u = _find_usage(rec)
            if u:
                usage["turns"] += 1
                usage["tokens"] += u.get("totalTokens", 0) or 0
                usage["cost"] += (u.get("cost") or {}).get("total", 0) or 0

            if rec.get("type") != "message":
                continue
            msg = rec.get("message") or {}
            role = msg.get("role")
            if role not in ("assistant", "user"):
                continue
            content = msg.get("content")
            if role == "user":
                # content may be a plain string, a list of strings, or a list
                # of blocks. Collect text from all three shapes.
                texts = []
                if isinstance(content, str):
                    texts.append(content)
                elif isinstance(content, list):
                    for b in content:
                        if isinstance(b, str):
                            texts.append(b)
                        elif isinstance(b, dict):
                            texts.append(str(b.get("text") or ""))
                for t in texts:
                    loaded += SKILL_BLOCK.findall(t)
                continue

            blocks = content if isinstance(content, list) else []
            for b in blocks:
                if isinstance(b, dict) and b.get("type") in TOOL_CALL_TYPES:
                    args = b.get("arguments")
                    text = args if isinstance(args, str) else json.dumps(args)
                    loaded += SKILL_PATH.findall(text or "")

    seen, out = set(), []
    for s in loaded:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out, usage


def _find_usage(o):
    if isinstance(o, dict):
        if isinstance(o.get("usage"), dict):
            return o["usage"]
        for v in o.values():
            r = _find_usage(v)
            if r:
                return r
    elif isinstance(o, list):
        for v in o:
            r = _find_usage(v)
            if r:
                return r
    return None


AVAILABLE = re.compile(r"<available_skills>(.*?)</available_skills>", re.S)
NAME_TAG = re.compile(r"<name>([a-z0-9][a-z0-9-]*)</name>")


def advertised_skills(agent_dir: Path) -> list[str]:
    """Skill names the isolated run actually advertised in its system prompt.

    This is the wiring check. It does not depend on the model choosing
    anything, so it separates "the harness never offered the skill" from
    "the model declined it".
    """
    for sf in sorted((agent_dir / "sessions").rglob("*.jsonl")):
        for line in sf.read_text(errors="replace").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("type") != "message":
                continue
            msg = rec.get("message") or {}
            if msg.get("role") != "system":
                continue
            # pi builds the system prompt as `sections`, not `content`:
            # content is "" and the catalogue lives in sections.skills.
            # Search the whole message so either shape works.
            m = AVAILABLE.search(json.dumps(msg))
            if m:
                return sorted(set(NAME_TAG.findall(m.group(1))))
    return []


def probe(model: str | None, timeout: int) -> int:
    """Step 0: prove the harness offers skills before trusting any score."""
    work = Path(tempfile.mkdtemp(prefix="skilleval-probe-"))
    agent_dir, fixture = work / "agent", work / "repo"
    build_agent_dir(agent_dir, None)
    build_fixture(fixture)
    cmd = ["pi", "-p", "Reply with the single word READY. Do not use any tool."]
    if model:
        cmd += ["-m", model]
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir),
           "NODE_EXTRA_CA_CERTS": str(Path.home() / ".config/certs/cato-root.pem")}
    try:
        subprocess.run(cmd, cwd=fixture, env=env, capture_output=True,
                       text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print("probe timed out", file=sys.stderr)

    names = advertised_skills(agent_dir)
    try:
        shutil.rmtree(work, ignore_errors=True)
    except OSError as e:
        print(f"  warning: could not clean {work}: {e}", file=sys.stderr)

    print(f"skills advertised to the model: {len(names)}")
    for n in names:
        print(f"  {n}")
    ok = len(names) > 0
    print(f"\nmechanism wired: {'YES' if ok else 'NO'}")
    if not ok:
        print("  The isolated agent dir advertised no skills at all, so every")
        print("  trigger score would be a foregone miss. Fix before running.")
    else:
        print("  Note: `pi -p` does not expand /skill:<name>, so this eval")
        print("  measures model-triggered loading only, not explicit invocation.")
    return 0 if ok else 1


def run_case(case: dict, rep: int, candidate: Path | None,
             model: str | None, timeout: int) -> dict:
    work = Path(tempfile.mkdtemp(prefix="skilleval-"))
    agent_dir, fixture = work / "agent", work / "repo"
    row = {"case": case["id"], "rep": rep, "expect": case.get("expect"),
           "tags": case.get("tags", []), "error": None, "timed_out": False}
    t0 = time.time()
    try:
        build_agent_dir(agent_dir, candidate)
        build_fixture(fixture)
        cmd = ["pi", "-p", case["prompt"]]
        if model:
            cmd += ["-m", model]
        env = {**os.environ,
               "PI_CODING_AGENT_DIR": str(agent_dir),
               "NODE_EXTRA_CA_CERTS": str(Path.home() / ".config/certs/cato-root.pem")}
        p = subprocess.run(cmd, cwd=fixture, env=env, capture_output=True,
                           text=True, timeout=timeout)
        if p.returncode != 0:
            row["error"] = (p.stderr or p.stdout or "")[-300:].strip()
        row["loaded"], usage = skills_loaded(agent_dir)
        row.update(usage)
    except subprocess.TimeoutExpired:
        row["timed_out"] = True
        try:
            row["loaded"], usage = skills_loaded(agent_dir)
            row.update(usage)
        except Exception:
            row["loaded"] = []
    except Exception as e:
        row["error"] = repr(e)[:300]
        row["loaded"] = []
    row["ms"] = int((time.time() - t0) * 1000)

    exp, got = row["expect"], row.get("loaded", [])
    if exp is None:
        row["verdict"] = "abstain" if not got else "false_trigger"
    else:
        row["verdict"] = "hit" if exp in got else "miss"
    row["correct"] = row["verdict"] in ("hit", "abstain")
    try:
        shutil.rmtree(work, ignore_errors=True)
    except OSError as e:
        print(f"  warning: could not clean {work}: {e}", file=sys.stderr)
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default=str(ROOT / "cases.jsonl"))
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--out", default=None)
    ap.add_argument("--candidate", default=None,
                    help="overlay dir applied on top of the agent dir")
    ap.add_argument("--only", default=None, help="comma-separated case ids")
    ap.add_argument("--model", default=None)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--probe", action="store_true",
                    help="Step 0: confirm a skill can be triggered at all")
    a = ap.parse_args()

    try:
        raw = Path(a.cases).read_text()
    except OSError as e:
        print(f"cannot read cases file {a.cases}: {e}", file=sys.stderr)
        return 2
    cases = []
    for n_line, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            cases.append(json.loads(line))
        except json.JSONDecodeError as e:
            print(f"{a.cases}:{n_line}: bad JSON: {e}", file=sys.stderr)
            return 2
    if a.only:
        want = {s.strip() for s in a.only.split(",")}
        cases = [c for c in cases if c["id"] in want]

    if a.probe:
        return probe(a.model, a.timeout)

    out = Path(a.out or ROOT / "runs" / time.strftime("%Y%m%dT%H%M%S"))
    out.mkdir(parents=True, exist_ok=True)
    res = out / "results.jsonl"
    total = len(cases) * a.reps
    print(f"{len(cases)} cases x {a.reps} reps = {total} pi runs -> {res}")
    print("Each run is a real model call. Ctrl-C to abort.\n")

    n = 0
    with res.open("w") as fh:
        for rep in range(a.reps):
            for c in cases:
                n += 1
                row = run_case(c, rep, Path(a.candidate) if a.candidate else None,
                               a.model, a.timeout)
                fh.write(json.dumps(row) + "\n")
                fh.flush()
                flag = "" if row["correct"] else "  <-"
                print(f"  [{n:>3}/{total}] {row['case']:<10} "
                      f"{row['verdict']:<14} {row['ms']:>6}ms{flag}")
    (out / "meta.json").write_text(json.dumps({
        "cases": a.cases, "reps": a.reps, "candidate": a.candidate,
        "model": a.model, "when": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "id": str(uuid.uuid4())[:8]}, indent=2))
    print(f"\nwrote {res}\nnext: bin/report.py {out} --gates")
    return 0


if __name__ == "__main__":
    sys.exit(main())
