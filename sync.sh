#!/usr/bin/env bash
# sync.sh — pull the live pi configuration into this repo.
#
# Copies CONFIG ONLY. Never touches memory, sessions, or any database.
# Safe to run repeatedly; review `git diff` afterwards before committing.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"

[[ -d "$A" ]] || {
  echo "error: $A not found — is pi installed?" >&2
  exit 1
}

echo "==> config"
for f in settings.json mcp.json AGENTS.md; do
  cp "$A/$f" "$REPO/config/$f"
  echo "    config/$f"
done

echo "==> npm manifests"
mkdir -p "$REPO/config/npm"
cp "$A/npm/package.json" "$A/npm/package-lock.json" "$REPO/config/npm/"
echo "    config/npm/package.json + package-lock.json"

echo "==> extension config"
mkdir -p "$REPO/config/extensions/pi-rtk-optimizer"
[[ -f "$A/extensions/aperture.json" ]] &&
  cp "$A/extensions/aperture.json" "$REPO/config/extensions/aperture.json" &&
  echo "    config/extensions/aperture.json"
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

# Directory extensions. index.ts is the discriminator: pi loads
# extensions/<name>/index.ts, whereas plugin config dirs (e.g.
# extensions/pi-rtk-optimizer/, which holds only config.json) have none and
# belong under config/extensions/ instead.
shopt -s nullglob
for d in "$A"/extensions/*/; do
  name="$(basename "$d")"
  if [[ ! -f "$d/index.ts" ]]; then
    echo "    skip $name/ (no index.ts — not an extension)"
    continue
  fi
  rm -rf "$REPO/extensions/$name"
  mkdir -p "$REPO/extensions/$name"
  # node_modules is a dev-only type dependency and is gitignored.
  (cd "$d" && tar cf - --exclude node_modules .) | (cd "$REPO/extensions/$name" && tar xf -)
  echo "    extensions/$name/ (directory extension)"
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
