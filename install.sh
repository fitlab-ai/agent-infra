#!/bin/sh
# agent-infra bootstrap installer
# Usage: curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh
set -e

NPM_PACKAGE="@fitlab-ai/agent-infra"

# ---------- helpers ----------
info()  { printf '  \033[1;34m>\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; }

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

# ---------- install via npm ----------
info "Installing $NPM_PACKAGE via npm ..."
npm install -g "$NPM_PACKAGE"
ok "agent-infra installed successfully!"

case "$(uname -s)" in
  Linux)
    if ! command -v docker >/dev/null 2>&1; then
      warn "Docker is not installed. Install Docker Engine before using 'ai sandbox create': https://docs.docker.com/engine/install/"
    elif ! docker info >/dev/null 2>&1; then
      warn "Docker is installed, but the daemon is not ready. Try: sudo systemctl enable --now docker"
      warn "If permission is denied, add your user to the docker group: sudo usermod -aG docker \$USER"
    else
      ok "Docker is ready."
    fi
    ;;
  Darwin)
    ok "macOS detected. Sandbox commands will use Colima/OrbStack via Homebrew on first run."
    ;;
esac

# ---------- done ----------
echo ""
echo "  Next step: cd into your project and run:"
echo "    agent-infra init  (or: ai init)"
echo ""
echo "  To update later:"
echo "    npm update -g $NPM_PACKAGE"
echo ""
echo "  Alternative install (macOS):"
echo "    brew install fitlab-ai/tap/agent-infra"
echo ""
