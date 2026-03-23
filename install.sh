#!/bin/sh
# agent-infra bootstrap installer
# Usage: curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh
set -e

NPM_PACKAGE="@fitlab-ai/agent-infra"
LEGACY_DIR="$HOME/.agent-infra"
LEGACY_BIN_DIR="$HOME/.local/bin"

# ---------- helpers ----------
info()  { printf '  \033[1;34m>\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; }

legacy_link_target() {
  target_path=$1
  if [ ! -L "$target_path" ]; then
    return 1
  fi
  readlink "$target_path" 2>/dev/null || return 1
}

# ---------- pre-checks ----------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js >= 18 is required but not found."
  err "Install Node.js: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(parseInt(process.versions.node)))' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  err "Node.js >= 18 is required (current: $(node --version))."
  err "Please upgrade: https://nodejs.org/"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm is required but not found."
  err "npm is bundled with Node.js >= 18. Please reinstall Node.js: https://nodejs.org/"
  exit 1
fi

# ---------- detect legacy clone install ----------
if [ -d "$LEGACY_DIR" ]; then
  echo ""
  warn "Detected legacy clone install at $LEGACY_DIR"
  warn "This script now installs via npm. The old clone directory is no longer needed."
  warn "After verifying the npm install works, you can remove it:"
  echo "    rm -rf $LEGACY_DIR"
  echo ""
fi

LEGACY_LINK_DETECTED=0

for legacy_link in "$LEGACY_BIN_DIR/ai" "$LEGACY_BIN_DIR/agent-infra"; do
  link_target=$(legacy_link_target "$legacy_link" || true)
  case "$link_target" in
    *".agent-infra"*)
      LEGACY_LINK_DETECTED=1
      ;;
  esac
done

if [ "$LEGACY_LINK_DETECTED" -eq 1 ]; then
  warn "Detected legacy symlink under $LEGACY_BIN_DIR"
  warn "After verifying the npm install works, you can remove it:"
  echo "    rm -f $LEGACY_BIN_DIR/ai $LEGACY_BIN_DIR/agent-infra"
  echo ""
fi

# ---------- install via npm ----------
info "Installing $NPM_PACKAGE via npm ..."
npm install -g "$NPM_PACKAGE"
ok "agent-infra installed successfully!"

# ---------- done ----------
echo ""
echo "  Next step: cd into your project and run:"
echo "    agent-infra init  (or: ai init)"
echo ""
echo "  To update later:"
echo "    npm update -g $NPM_PACKAGE"
echo ""
