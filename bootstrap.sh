#!/usr/bin/env bash
# bootstrap.sh — restore this pi configuration onto a machine.
#
# Idempotent. Restores CONFIG ONLY — it never writes memory or session data.
# Existing files are backed up to *.pre-bootstrap unless --force is passed.
#
#   ./bootstrap.sh              # full restore
#   ./bootstrap.sh --config     # config files only, skip `pi install`
#   ./bootstrap.sh --force      # overwrite without backups
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"
FORCE=0
CONFIG_ONLY=0
for arg in "$@"; do
  case "$arg" in
  --force) FORCE=1 ;;
  --config) CONFIG_ONLY=1 ;;
  *)
    echo "unknown flag: $arg" >&2
    exit 2
    ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || {
  echo "error: '$1' is required but not installed" >&2
  exit 1
}; }
need pi
need jq
need git

# install <src> <dest> — copy with a one-time backup of any existing file
install_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [[ -e "$dest" && $FORCE -eq 0 && ! -e "$dest.pre-bootstrap" ]]; then
    cp "$dest" "$dest.pre-bootstrap"
    echo "    backed up $(basename "$dest") -> $(basename "$dest").pre-bootstrap"
  fi
  cp "$src" "$dest"
  echo "    $dest"
}

echo "==> config -> $A"
for f in settings.json mcp.json AGENTS.md hermes-memory-config.json; do
  install_file "$REPO/config/$f" "$A/$f"
done

# hermes does no tilde expansion, so childExtensionPaths must be absolute. Re-root
# any committed path onto THIS machine's agent dir, otherwise a restore under a
# different username silently points at a nonexistent provider extension and the
# memory auto-review fails with "No API provider registered".
if [[ -f "$A/hermes-memory-config.json" ]] && command -v jq >/dev/null 2>&1; then
  tmp="$(mktemp)"
  if jq --arg base "$A" '
        if .childExtensionPaths then
          .childExtensionPaths |= map(sub(".*/\\.pi/agent/"; $base + "/"))
        else . end
      ' "$A/hermes-memory-config.json" >"$tmp" 2>/dev/null; then
    mv "$tmp" "$A/hermes-memory-config.json"
    echo "    re-rooted childExtensionPaths onto $A"
  else
    rm -f "$tmp"
    echo "    WARN: could not re-root childExtensionPaths; check it by hand" >&2
  fi
fi
install_file "$REPO/config/npm/package.json" "$A/npm/package.json"
install_file "$REPO/config/npm/package-lock.json" "$A/npm/package-lock.json"

echo "==> extension config"
[[ -f "$REPO/config/extensions/aperture.json" ]] &&
  install_file "$REPO/config/extensions/aperture.json" "$A/extensions/aperture.json"
[[ -f "$REPO/config/extensions/pi-rtk-optimizer/config.json" ]] &&
  install_file "$REPO/config/extensions/pi-rtk-optimizer/config.json" \
    "$A/extensions/pi-rtk-optimizer/config.json"

echo "==> my extensions"
shopt -s nullglob
for f in "$REPO"/extensions/*.ts "$REPO"/extensions/*.js; do
  install_file "$f" "$A/extensions/$(basename "$f")"
done
# Directory extensions (pi loads extensions/<name>/index.ts). Install RUNTIME
# files only: node_modules is a dev-only type dependency, and the test files
# import bun:test which pi cannot resolve — neither belongs in the live dir.
for d in "$REPO"/extensions/*/; do
  name="$(basename "$d")"
  [[ -f "$d/index.ts" ]] || continue
  dest="$A/extensions/$name"
  if [[ -e "$dest" && $FORCE -eq 0 && ! -e "$dest.pre-bootstrap" ]]; then
    cp -R "$dest" "$dest.pre-bootstrap"
    echo "    backed up $name -> $name.pre-bootstrap"
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
  (cd "$d" && tar cf - \
    --exclude node_modules --exclude '*.test.ts' --exclude smoke.ts \
    --exclude fixtures --exclude tsconfig.json --exclude 'package*.json' .) |
    (cd "$dest" && tar xf -)
  echo "    $dest/ (directory extension, runtime files only)"
done
shopt -u nullglob

# Debug adapters for the vendored dap extension. Idempotent; skipped with
# --config since it downloads and builds.
if [[ $CONFIG_ONLY -eq 0 && -x "$REPO/scripts/install-dap-adapters.sh" ]]; then
  echo "==> debug adapters"
  "$REPO/scripts/install-dap-adapters.sh" || echo "    WARN: adapter install reported problems" >&2
fi

echo "==> my skills"
while read -r s; do
  [[ -z "$s" || "$s" == \#* ]] && continue
  if [[ -d "$REPO/skills/$s" ]]; then
    rm -rf "$A/skills/$s"
    mkdir -p "$A/skills"
    cp -R "$REPO/skills/$s" "$A/skills/$s"
    echo "    $A/skills/$s"
  fi
done <"$REPO/manifests/my-skills.txt"

if [[ $CONFIG_ONLY -eq 1 ]]; then
  echo
  echo "Config restored (--config). Skipped package installs."
  exit 0
fi

echo "==> pi packages (regenerates plugin skills + agents)"
# settings.json packages[] is the source of truth. Each entry is already a
# fully-qualified spec, e.g. npm:pi-lens or git:github.com/user/repo@tag.
jq -r '.packages[]?' "$REPO/config/settings.json" | while read -r p; do
  [[ -z "$p" ]] && continue
  echo "    pi install $p"
  pi install "$p" || echo "    WARN: failed to install $p — continuing" >&2
done

echo "==> third-party skills (~/.agents/skills)"
LOCK="$REPO/manifests/agents-skill-lock.json"
if [[ -f "$LOCK" ]]; then
  mkdir -p "$AGENTS_HOME/skills"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  jq -r '.skills | to_entries[] | "\(.key)\t\(.value.sourceUrl)\t\(.value.skillPath)"' "$LOCK" |
    while IFS=$'\t' read -r name url skillpath; do
      if [[ -d "$AGENTS_HOME/skills/$name" ]]; then
        echo "    $name already present, skipping"
        continue
      fi
      echo "    cloning $name from $url"
      if git clone --depth 1 --quiet "$url" "$tmp/$name" 2>/dev/null; then
        # skillPath points at the SKILL.md; we want its containing folder
        srcdir="$tmp/$name/$(dirname "$skillpath")"
        [[ -f "$tmp/$name/$skillpath" ]] && cp -R "$srcdir" "$AGENTS_HOME/skills/$name" ||
          echo "    WARN: $skillpath not found in $name" >&2
      else
        echo "    WARN: clone failed for $name" >&2
      fi
    done
  install_file "$LOCK" "$AGENTS_HOME/.skill-lock.json"
fi

cat <<'EOF'

────────────────────────────────────────────────────────────────
Restore complete. Manual steps that cannot be automated:

  1. Auth       — run `pi` and sign in; credentials live in
                  ~/.pi/agent/auth.json (never versioned).
  2. Trust      — pi re-prompts per directory on first use;
                  ~/.pi/agent/trust.json is machine-specific.
  3. Aperture   — config/extensions/aperture.json points at a
                  private tailnet gateway. Join the tailnet or
                  edit baseUrl before first run.
  4. Memory     — intentionally NOT restored. See docs/BOUNDARY.md.
  5. Natives    — if memory_search errors with NODE_MODULE_VERSION,
                  see skills/rebuild-pi-native-modules/.

Verify with:  pi --version && pi doctor 2>/dev/null || true
────────────────────────────────────────────────────────────────
EOF
