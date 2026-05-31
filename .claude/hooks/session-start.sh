#!/bin/bash
# SessionStart hook — provision the Claude Code web sandbox so the full
# `bun test` suite (incl. any Bun.WebView integration tests) runs.
#
# Self-contained and project-agnostic: copy this file + the SessionStart entry
# in .claude/settings.json into any Bun project (railroad, delta, hjeli, ...).
# Web sandbox only — locally you already have Bun and a browser, so it exits
# immediately. See CLAUDE.md › "Testing in the Claude Code web sandbox".
#
# Runs synchronously so dependencies and the browser are ready before the
# agent loop starts.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# 1. Bun.WebView needs Bun >= 1.3.12; the base image ships 1.3.11. The npm
#    registry is reachable, so upgrade only if we're below the floor.
need_bun_upgrade=0
if ! command -v bun >/dev/null 2>&1; then
  need_bun_upgrade=1
else
  ver="$(bun --version)"
  if [ "$(printf '%s\n1.3.12\n' "$ver" | sort -V | head -n1)" != "1.3.12" ]; then
    need_bun_upgrade=1
  fi
fi
[ "$need_bun_upgrade" = "1" ] && npm install -g bun@latest

# 2. Dev dependencies (install, not ci, so the container cache is reused).
bun install

# 3. Stage a headless Chromium for Bun.WebView (idempotent).
#    On Linux, Bun.WebView speaks CDP to an installed Chrome/Chromium found via
#    $BUN_CHROME_PATH. The sandbox ships no browser, apt's chromium is a snap
#    stub, and the browser CDNs are egress-blocked — but npm and GitHub are
#    reachable, so we pull a real headless build out of the @sparticuz/chromium
#    tarball (binary bundled inside, not fetched from a CDN).
DEST=/opt/chromium
SHIM="$DEST/chrome-shim.sh"
if [ ! -x "$DEST/chromium" ]; then
  # Two preinstalled PPAs (deadsnakes, ondrej/php) 403 and abort `apt update`.
  for f in /etc/apt/sources.list.d/deadsnakes-ubuntu-ppa-*.sources \
           /etc/apt/sources.list.d/ondrej-ubuntu-php-*.sources; do
    [ -f "$f" ] && mv "$f" "$f.disabled" || true
  done

  # Chromium's C/font/X system libraries (apt only, no CDN).
  npx --yes playwright@latest install-deps chromium

  # Pull the bundled Chromium build from npm and unpack it.
  TMP="$(mktemp -d)"
  ( cd "$TMP" && npm pack @sparticuz/chromium >/dev/null && tar xzf sparticuz-chromium-*.tgz )
  mkdir -p "$DEST"
  node -e "const fs=require('fs'),z=require('zlib');fs.writeFileSync('$DEST/chromium',z.brotliDecompressSync(fs.readFileSync('$TMP/package/bin/chromium.br')))"
  chmod +x "$DEST/chromium"
  # swiftshader (software GL) libs, resolved relative to argv[0].
  node -e "const fs=require('fs'),z=require('zlib');fs.writeFileSync('$TMP/swiftshader.tar',z.brotliDecompressSync(fs.readFileSync('$TMP/package/bin/swiftshader.tar.br')))"
  tar xf "$TMP/swiftshader.tar" -C "$DEST"
  rm -rf "$TMP"
fi

# (Re)write the launch shim. Bun.WebView spawns this over a CDP pipe; without
# --no-sandbox a root-owned Chromium aborts ("Chrome process closed the pipe").
cat > "$SHIM" <<'EOF'
#!/bin/sh
exec /opt/chromium/chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  "$@"
EOF
chmod +x "$SHIM"

# 4. Persist the browser path for the whole session so `bun test` finds it.
echo "export BUN_CHROME_PATH=$SHIM" >> "$CLAUDE_ENV_FILE"
