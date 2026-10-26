#!/usr/bin/env bash
# sync.sh — pull the live pi configuration into this repo.
#
# Copies CONFIG ONLY. Never touches memory, sessions, or any database.
# Safe to run repeatedly; review `git diff` afterwards before committing.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"
FISH_CONFD="$HOME/.config/fish/conf.d"

[[ -d "$A" ]] || {
  echo "error: $A not found — is pi installed?" >&2
  exit 1
}

echo "==> config"
for f in settings.json models.json mcp.json AGENTS.md; do
  if [[ -f "$A/$f" ]]; then
    cp "$A/$f" "$REPO/config/$f"
    echo "    config/$f"
  else
    echo "    skip $f (not present)"
  fi
done

echo "==> shell integration"
mkdir -p "$REPO/config/fish"
if [[ -f "$FISH_CONFD/pi-fff-mode.fish" ]]; then
  cp "$FISH_CONFD/pi-fff-mode.fish" "$REPO/config/fish/pi-fff-mode.fish"
  echo "    config/fish/pi-fff-mode.fish"
else
  echo "    skip pi-fff-mode.fish (not present)"
fi

echo "==> npm manifests"
mkdir -p "$REPO/config/npm"
cp "$A/npm/package.json" "$A/npm/package-lock.json" "$REPO/config/npm/"
echo "    config/npm/package.json + package-lock.json"

# The Aperture gateway publishes its own catalogue, so models.json can drift
# behind it silently. Report that here rather than discovering it months later;
# --check never writes, so a sync stays a capture-only operation.
echo "==> aperture catalogue drift"
if "$REPO/scripts/sync-aperture-models.py" --check >/tmp/aperture-drift.$$ 2>&1; then
  echo "    models.json matches the gateway"
else
  rc=$?
  if [[ $rc -eq 1 ]]; then
    echo "    DRIFT — the gateway serves models that models.json does not list:"
    sed -n '/=== added ===/,/=== field changes/p' /tmp/aperture-drift.$$ |
      grep -E '^  [a-z]' | sed 's/^/    /'
    echo "    run: scripts/sync-aperture-models.py   (then review git diff)"
  else
    echo "    skipped (gateway unreachable — is the tailnet up?)"
  fi
fi
rm -f /tmp/aperture-drift.$$

echo "==> extension config"
mkdir -p "$REPO/config/extensions/pi-rtk-optimizer"
[[ -f "$A/extensions/pi-rtk-optimizer/config.json" ]] &&
  cp "$A/extensions/pi-rtk-optimizer/config.json" "$REPO/config/extensions/pi-rtk-optimizer/config.json" &&
  echo "    config/extensions/pi-rtk-optimizer/config.json"

echo "==> my extensions"
# Anything in ~/.pi/agent/extensions/ that is NOT tool-managed and NOT a
# config file for an installed plugin. herdr's file is .gitignore'd.
mkdir -p "$REPO/extensions"
find "$A/extensions" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.js' \) -print0 |
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    if head -3 "$f" | grep -qiE 'installed by|managed by'; then
      echo "    skip $base (tool-managed)"
    else
      cp "$f" "$REPO/extensions/$base"
      echo "    extensions/$base"
    fi
  done

# Directory extensions tracked in repo. This is pull-only (repo → live),
# not sync, so we never copy FROM live (which omits test/dev files) back into
# the repo. Bootstrap.sh does the reverse (repo → live).
shopt -s nullglob
for f in "$REPO"/extensions/*/index.ts; do
  name="$(basename "$(dirname "$f")")"
  # Skip if already installed to live (bootstrap handles the install).
  [[ -f "$A/extensions/$name/index.ts" ]] && continue
  echo "    (extensions/$name not yet installed to live — bootstrap will do it)"
done
shopt -u nullglob

echo "==> my skills (allowlist: manifests/my-skills.txt)"
while read -r s; do
  [[ -z "$s" || "$s" == \#* ]] && continue
  if [[ -d "$A/skills/$s" ]]; then
    rm -rf "$REPO/skills/$s"
    cp -R "$A/skills/$s" "$REPO/skills/$s"
    echo "    skills/$s"
  else
    echo "    WARN: $s listed in manifest but missing from $A/skills/" >&2
  fi
done <"$REPO/manifests/my-skills.txt"

echo "==> third-party skill manifest"
[[ -f "$AGENTS_HOME/.skill-lock.json" ]] &&
  cp "$AGENTS_HOME/.skill-lock.json" "$REPO/manifests/agents-skill-lock.json" &&
  echo "    manifests/agents-skill-lock.json"

echo
echo "Done. Review before committing:"
echo "    git -C \"$REPO\" status --short"
echo "    git -C \"$REPO\" diff"
