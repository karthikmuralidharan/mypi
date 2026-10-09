#!/usr/bin/env bash
# Make package-provided skills explicit-invocation only.
#
# Why: pi advertises every discovered skill's name + description in the system
# prompt on every turn. The compound-engineering package ships 36 skills and
# marks only 9 of them `disable-model-invocation: true`, leaving 27 advertised
# for roughly 9 KB of prompt on every request. These are explicitly-invoked
# workflows, so automatic model selection buys nothing.
#
# `disable-model-invocation: true` removes a skill from the prompt catalogue
# while keeping it fully usable: `/skill:<name>` still works, and another skill
# can still reference its file. See pi docs/skills.md.
#
# There is no settings-level equivalent — pi's `skills` array `-path` entries
# set `enabled: false`, which is a stronger, different thing. So the flag must
# live in frontmatter, and `pi update` overwrites package files. Re-run this
# after every `pi update`. It is idempotent.

set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PKG="$AGENT_DIR/git/github.com/EveryInc/compound-engineering-plugin"

if [[ ! -d "$PKG/skills" ]]; then
  echo "compound-engineering package not installed; nothing to do"
  exit 0
fi

flagged=0
already=0
for skill in "$PKG"/skills/*/SKILL.md; do
  [[ -f "$skill" ]] || continue
  name="$(basename "$(dirname "$skill")")"

  if grep -qE '^disable-model-invocation:' "$skill"; then
    already=$((already + 1))
    continue
  fi

  # insert the key just before the closing frontmatter delimiter
  awk '
    NR == 1 && /^---$/ { print; infm = 1; next }
    infm && /^---$/     { print "disable-model-invocation: true"; print; infm = 0; next }
                        { print }
  ' "$skill" > "$skill.tmp" && mv "$skill.tmp" "$skill"

  flagged=$((flagged + 1))
  echo "    hidden from catalogue: $name"
done

echo "==> $flagged newly flagged, $already already set"
echo "    all remain callable with /skill:<name>"
