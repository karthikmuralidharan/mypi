#!/usr/bin/env python3
"""Serialize loop writes across worktrees of a Git clone."""

import fcntl
import os
from pathlib import Path
import subprocess
import sys


common_dir = Path(subprocess.check_output(
    ["git", "rev-parse", "--git-common-dir"], text=True
).strip()).resolve()
run_dir = common_dir / "loop"
run_dir.mkdir(mode=0o700, exist_ok=True)
lock_fd = os.open(run_dir / "write.lock", os.O_CREAT | os.O_WRONLY, 0o600)
fcntl.flock(lock_fd, fcntl.LOCK_EX)
# Retain the lock across exec. The kernel releases it after the writer exits.
os.set_inheritable(lock_fd, True)
os.environ["LOOP_WRITE_LOCK"] = str(run_dir)
os.execv(sys.argv[1], sys.argv[1:])
