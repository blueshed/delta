#!/bin/bash
# SessionStart hook — self-provision the test environment for Claude Code on
# the web. Provisions everything CLAUDE.md documents as manual per-container
# setup, so a fresh (ephemeral) container can run the full test suite without
# hand-holding:
#
#   - bundled Postgres 16 cluster started (ships down, listens on :5432)
#   - `delta` role + `delta_test` DB created (mirrors the compose stack)
#   - latest Bun installed via npm (an upgraded bun does not survive a fresh
#     container)
#   - JS deps installed (bun install)
#   - DELTA_TEST_PG_URL exported for the session (so `bun test tests/` just works)
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

# 2. Start the bundled Postgres 16 cluster if it isn't already accepting
#    connections, then wait for readiness.
if ! pg_isready -q -p 5432 2>/dev/null; then
  pg_ctlcluster 16 main start
fi
for _ in $(seq 1 20); do
  pg_isready -q -p 5432 2>/dev/null && break
  sleep 0.5
done
log "postgres up on :5432"

# 3. Create the delta role + delta_test DB (idempotent). The role is a
#    SUPERUSER to mirror the compose stack (POSTGRES_USER=delta); see the
#    BYPASSRLS note in CLAUDE.md. No $$ DO-block, to keep quoting simple.
role_exists="$(su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='delta'\"")"
if [ "$role_exists" != "1" ]; then
  su postgres -c "psql -c \"CREATE ROLE delta LOGIN SUPERUSER PASSWORD 'delta'\"" >/dev/null
fi
db_exists="$(su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='delta_test'\"")"
if [ "$db_exists" != "1" ]; then
  su postgres -c "createdb -O delta delta_test"
fi
log "role 'delta' + db 'delta_test' ready"

# 4. Point the test suite at the local cluster (:5432, not the compose :5433)
#    for the whole session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export DELTA_TEST_PG_URL="postgres://delta:delta@localhost:5432/delta_test"' >> "$CLAUDE_ENV_FILE"
fi

# 5. JS deps. `bun install` (not a frozen/ci variant) so the cached container
#    keeps the resolved deps.
bun install >/dev/null 2>&1 || bun install
log "bun install complete"

# 6. Optional webview/chromium provisioning. Drop an executable
#    scripts/setup-webview.sh into the repo to enable it (e.g. for
#    browser-driven testing of the examples); it runs only if present and a
#    failure here is non-fatal to the session.
if [ -x "$PROJECT_DIR/scripts/setup-webview.sh" ]; then
  log "running scripts/setup-webview.sh…"
  "$PROJECT_DIR/scripts/setup-webview.sh" || log "scripts/setup-webview.sh failed (non-fatal)"
fi

log "done."
