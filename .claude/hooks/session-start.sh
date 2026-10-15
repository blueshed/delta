#!/bin/bash
# SessionStart hook — self-provision the test environment for Claude Code on
# the web. Provisions everything CLAUDE.md documents as manual per-container
# setup, so a fresh (ephemeral) container can run the full test suite without
# hand-holding:
#
#   - latest Bun installed via npm (an upgraded bun does not survive a fresh
#     container)
#   - JS deps installed (bun install)
#   - optional scripts/setup-webview.sh run if you add one (chromium/webview)
#
# Idempotent and non-interactive: safe to run on every session start.
set -euo pipefail

# Progress goes to stderr so it doesn't pollute the session context (stdout).
log() { echo "[session-start] $*" >&2; }

# Only provision in the remote (web) container; local machines manage their own.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"

log "provisioning test environment…"

# 1. Latest Bun via npm. The preinstalled bun (and any upgrade) is lost on a
#    fresh container, so reinstall every session; npm is a no-op if current.
if command -v npm >/dev/null 2>&1; then
  npm install -g bun >/dev/null 2>&1 || true
  log "bun $(bun --version 2>/dev/null || echo '?') ready"
fi

# 2. JS deps. `bun install` (not a frozen/ci variant) so the cached container
#    keeps the resolved deps.
bun install >/dev/null 2>&1 || bun install
log "bun install complete"

# 3. Optional webview/chromium provisioning. Drop an executable
#    scripts/setup-webview.sh into the repo to enable it (e.g. for
#    browser-driven testing of the examples); it runs only if present and a
#    failure here is non-fatal to the session.
if [ -x "$PROJECT_DIR/scripts/setup-webview.sh" ]; then
  log "running scripts/setup-webview.sh…"
  "$PROJECT_DIR/scripts/setup-webview.sh" || log "scripts/setup-webview.sh failed (non-fatal)"
fi

log "done."
