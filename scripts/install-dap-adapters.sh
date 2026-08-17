#!/usr/bin/env bash
# install-dap-adapters.sh — install the debug adapters the dap extension expects.
#
# Idempotent: re-running skips anything already present. Adapters land in
# ~/.pi/dap-adapters/ (plus dlv via homebrew) and are referenced by absolute path
# from extensions/dap/defaults.json, so nothing depends on PATH ordering or on a
# bare `python` existing.
#
#   ./scripts/install-dap-adapters.sh            # install all
#   ./scripts/install-dap-adapters.sh --check    # report status only
set -uo pipefail

A="$HOME/.pi/dap-adapters"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

ok() { printf '  OK    %s\n' "$1"; }
miss() { printf '  MISS  %s\n' "$1"; }
fail() { printf '  FAIL  %s -- %s\n' "$1" "$2"; }

have_debugpy() { [[ -x "$A/py/bin/python" ]] && "$A/py/bin/python" -c 'import debugpy' 2>/dev/null; }
have_jsdebug() { [[ -f "$A/js-debug/src/dapDebugServer.js" ]]; }
have_dlv() { command -v dlv >/dev/null 2>&1; }

if [[ $CHECK_ONLY -eq 1 ]]; then
  if have_debugpy; then ok "debugpy ($A/py)"; else miss "debugpy"; fi
  if have_dlv; then ok "dlv ($(command -v dlv))"; else miss "dlv"; fi
  if have_jsdebug; then ok "js-debug ($A/js-debug)"; else miss "js-debug"; fi
  exit 0
fi

mkdir -p "$A"

# --- Python: debugpy in an isolated venv --------------------------------------
# A venv avoids PEP 668 ("externally managed environment") on homebrew python and
# keeps the adapter off the system interpreter entirely.
if have_debugpy; then
  ok "debugpy already installed"
elif ! command -v uv >/dev/null 2>&1; then
  fail debugpy "uv not found; install uv or create $A/py manually"
elif uv venv "$A/py" --quiet 2>/dev/null && VIRTUAL_ENV="$A/py" uv pip install --quiet debugpy 2>/dev/null; then
  ok "debugpy $("$A/py/bin/python" -c 'import debugpy;print(debugpy.__version__)' 2>/dev/null)"
else
  fail debugpy "venv or pip install failed"
fi

# --- Go: delve ----------------------------------------------------------------
if have_dlv; then
  ok "dlv already installed ($(command -v dlv))"
elif command -v brew >/dev/null 2>&1 && brew install delve >/dev/null 2>&1; then
  ok "dlv via homebrew"
elif command -v go >/dev/null 2>&1 && go install github.com/go-delve/delve/cmd/dlv@latest >/dev/null 2>&1; then
  ok "dlv via go install (ensure GOBIN is on PATH)"
else
  fail dlv "needs brew or go"
fi

# --- JS/TS: vscode-js-debug DAP server ---------------------------------------
# The `js-debug-adapter` npm package does not exist; the DAP server ships as a
# tarball on the vscode-js-debug releases page.
if have_jsdebug; then
  ok "js-debug already installed"
else
  URL="$(curl -sL https://api.github.com/repos/microsoft/vscode-js-debug/releases/latest |
    grep -o 'https://[^"]*js-debug-dap-v[0-9.]*\.tar\.gz' | head -1)"
  if [[ -n "$URL" ]] && curl -sL "$URL" -o /tmp/js-debug-dap.tgz && tar xzf /tmp/js-debug-dap.tgz -C "$A"; then
    if have_jsdebug; then
      ok "js-debug from $(basename "$URL")"
    else
      fail js-debug "extracted but src/dapDebugServer.js missing"
    fi
  else
    fail js-debug "download failed (url=${URL:-none})"
  fi
  rm -f /tmp/js-debug-dap.tgz
fi

echo
echo "Adapters resolve to:"
printf '  debugpy  : %s -m debugpy.adapter\n' "$A/py/bin/python"
printf '  dlv      : %s dap\n' "$(command -v dlv || echo '(missing)')"
printf '  js-debug : node %s PORT 127.0.0.1  (PORT injected at launch)\n' "$A/js-debug/src/dapDebugServer.js"
echo
echo "Verify end to end with:  bun extensions/dap/smoke.ts"
