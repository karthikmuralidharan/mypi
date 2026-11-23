---
name: eng-loop-jira-gh-sync-tooling
description: Maintain the loop skill and its GitHub and Jira scripts. Use when editing the loop CLI, its run state, or its ticket and pull request checks.
version: 4
created: "2026-07-26"
updated: "2026-11-21"
---

# Maintain the loop tooling

MyPi keeps the source in `skills/loop`. The installed skill and CLI live in
`~/.agents/skills/loop`. Pi discovers the shared skill as `/skill:loop`.

- Read `loop/SKILL.md` and `loop/references/operations.md` in the copy you edit.
- Read `loop/scripts/loop` for the current commands and approval checks.
- Reuse the GitHub and Jira helpers in `loop/scripts/lib/common.sh`.
- Before changing a write command, check how it recovers when a request
  succeeds but the response is lost.
- Test changes with the mocked suite. From the `loop` directory, run
  `python3 tests/test_loop.py` with Bash 4 or later on `PATH`.
