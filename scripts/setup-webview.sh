#!/bin/bash
# setup-webview.sh — provision a headless Chromium for browser-driven testing
# of the examples (kanban / shared-state) on Claude Code web.
#
# The web image ships Playwright (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers)
# and usually a pre-baked Chromium build, but a fresh container may not have
# the browser downloaded yet. This script:
#   1. ensures Playwright's Chromium is installed (idempotent; downloads only
#      when missing),
#   2. exposes it at the stable path /opt/chromium,
#   3. smoke-tests a headless launch.
#
# Invoked automatically by .claude/hooks/session-start.sh when present and
# executable. Safe to run standalone and on every session start.
set -euo pipefail

log() { echo "[setup-webview] $*" >&2; }

PW_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export PLAYWRIGHT_BROWSERS_PATH="$PW_PATH"

# 1. Ensure Playwright's Chromium is present. No-op when the build already
#    exists; downloads it on a fresh container. Tolerate failure if a browser
#    is already on disk (e.g. offline but image-baked).
if command -v playwright >/dev/null 2>&1; then
  playwright install chromium >/dev/null 2>&1 \
    || log "playwright install chromium failed (continuing if a build exists)"
else
  log "playwright CLI not found; relying on a pre-baked Chromium"
fi

# 2. Resolve the Chromium binary — prefer the stable symlink, fall back to the
#    newest versioned build directory.
chrome=""
if [ -e "$PW_PATH/chromium" ]; then
  chrome="$(readlink -f "$PW_PATH/chromium" 2>/dev/null || true)"
fi
if [ -z "$chrome" ] || [ ! -x "$chrome" ]; then
  chrome="$(ls -1 "$PW_PATH"/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$chrome" ] || [ ! -x "$chrome" ]; then
  log "no Chromium binary found under $PW_PATH — webview unavailable"
  exit 1
fi

# 3. Expose it at the stable path /opt/chromium (refresh the symlink so it
#    survives a Chromium version bump).
ln -sfn "$chrome" /opt/chromium
log "linked /opt/chromium -> $chrome"

# Persist a convenience env var for the session when the hook provides the file.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export CHROMIUM_BIN="/opt/chromium"' >> "$CLAUDE_ENV_FILE"
fi

# 4. Headless smoke test — fail loudly if the binary can't actually launch.
if /opt/chromium --headless=new --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1; then
  log "headless launch OK ($(/opt/chromium --version 2>/dev/null))"
else
  log "headless smoke test FAILED"
  exit 1
fi
