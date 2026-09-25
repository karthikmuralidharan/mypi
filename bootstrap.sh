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
FISH_CONFD="$HOME/.config/fish/conf.d"
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
for f in settings.json models.json mcp.json AGENTS.md; do
  install_file "$REPO/config/$f" "$A/$f"
done

echo "==> shell integration"
if command -v fish >/dev/null 2>&1; then
  [[ -f "$REPO/config/fish/pi-fff-mode.fish" ]] &&
    install_file "$REPO/config/fish/pi-fff-mode.fish" "$FISH_CONFD/pi-fff-mode.fish"
  [[ -f "$REPO/config/fish/go-bin-path.fish" ]] &&
    install_file "$REPO/config/fish/go-bin-path.fish" "$FISH_CONFD/go-bin-path.fish"
else
  echo "    skip fish conf.d files (fish not installed)"
fi

install_file "$REPO/config/npm/package.json" "$A/npm/package.json"
install_file "$REPO/config/npm/package-lock.json" "$A/npm/package-lock.json"

echo "==> extension config"
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
  # Backups live OUTSIDE $A/extensions/, never as a sibling directory in it:
  # pi's extension loader treats any subdirectory there with an index.ts as
  # a loadable extension regardless of its name, so a same-named
  # ".pre-bootstrap" sibling used to get loaded too and duplicate-register
  # every tool the real extension already registered.
  backup="$A/extensions-pre-bootstrap/$name"
  if [[ -e "$dest" && $FORCE -eq 0 && ! -e "$backup" ]]; then
    mkdir -p "$(dirname "$backup")"
    cp -R "$dest" "$backup"
    echo "    backed up $name -> extensions-pre-bootstrap/$name"
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

echo "==> mnemosyne CLI (runtime dep of @mnemosyne-oss/pi-mnemosyne)"
# The extension proxies every mnemosyne_* tool call to the `mnemosyne` binary
# via spawn; without it the tools install fine but error at call time. uv tool
# install keeps it isolated and puts the binary on PATH at ~/.local/bin.
if command -v mnemosyne >/dev/null 2>&1; then
  echo "    mnemosyne already on PATH ($(command -v mnemosyne)) — skipping"
elif command -v uv >/dev/null 2>&1; then
  uv tool install mnemosyne-memory ||
    echo "    WARN: uv tool install failed — install mnemosyne-memory by hand" >&2
else
  echo "    WARN: uv not found — install uv, then: uv tool install mnemosyne-memory" >&2
fi

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

  1. Auth       — run `pi` and sign in for any non-Aperture provider (e.g.
                  ChatGPT Plus/Pro OAuth for Codex models); credentials live
                  in ~/.pi/agent/auth.json (never versioned).
  2. Tailnet    — all model routing comes from ~/.pi/agent/models.json,
                  which points at the Aperture gateway; the tailnet must be
                  joined (or bridge mode) for it to resolve.
  3. Trust      — pi re-prompts per directory on first use;
                  ~/.pi/agent/trust.json is machine-specific.
  4. Memory     — data intentionally NOT restored (docs/BOUNDARY.md). The
                  mnemosyne CLI itself was installed above when uv was present;
                  if it warned, run: uv tool install mnemosyne-memory
  5. Natives    — if a tool errors with NODE_MODULE_VERSION,
                  see skills/rebuild-pi-native-modules/.

Verify with:  pi --version
────────────────────────────────────────────────────────────────
EOF
