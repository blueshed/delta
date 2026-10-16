#!/bin/bash
# SessionStart hook: provisions Claude Code on the web's ephemeral container so the gate
# (`bun run ci`) runs there as it does locally. It installs the Bun version CI pins (1.4.3: the
# container's own is older and lost with it; npm is the one installer its network allows),
# then the dependencies. Does nothing on any other machine. Idempotent and non-interactive.
set -euo pipefail

# Progress goes to stderr so it doesn't pollute the session context (stdout).
log() { echo "[session-start] $*" >&2; }

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
log "provisioning…"

if command -v npm >/dev/null 2>&1; then
  npm install -g bun@1.4.3 >/dev/null 2>&1 || true
  log "bun $(bun --version 2>/dev/null || echo '?') ready"
fi

bun install >/dev/null 2>&1 || bun install
log "done."
