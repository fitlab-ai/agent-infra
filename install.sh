#!/bin/sh
# agent-orchestrator bootstrap installer
# Usage: curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-orchestrator/main/install.sh | sh
set -e

REPO_OWNER="fitlab-ai"
REPO_NAME="agent-orchestrator"
REPO_SSH="git@github.com:${REPO_OWNER}/${REPO_NAME}.git"
REPO_HTTPS="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
INSTALL_DIR="$HOME/.agent-orchestrator"
# Symlink name for the installed command in PATH.
BIN_NAME="agent-orchestrator"

# ---------- helpers ----------
info()  { printf '  \033[1;34m>\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
err()   { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; }

# ---------- pre-checks ----------
if ! command -v git >/dev/null 2>&1; then
  err "git is required but not found. Please install git first."
  exit 1
fi

# ---------- select clone method ----------
# Priority: gh CLI > SSH > HTTPS
select_repo_url() {
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    # gh is authenticated — let it handle the clone directly
    echo "gh"
    return
  fi
  if ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
    echo "$REPO_SSH"
    return
  fi
  echo "$REPO_HTTPS"
}

# ---------- clone or update ----------
if [ -d "$INSTALL_DIR" ]; then
  info "Updating existing installation at $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" fetch --tags --quiet
  ok "Fetched latest tags."
else
  CLONE_METHOD=$(select_repo_url)
  if [ "$CLONE_METHOD" = "gh" ]; then
    info "Cloning agent-orchestrator via gh CLI to $INSTALL_DIR ..."
    gh repo clone "${REPO_OWNER}/${REPO_NAME}" "$INSTALL_DIR" -- --quiet
  else
    info "Cloning agent-orchestrator to $INSTALL_DIR ..."
    git clone --quiet "$CLONE_METHOD" "$INSTALL_DIR"
  fi
  ok "Cloned successfully."
fi

LATEST_TAG=$(git -C "$INSTALL_DIR" tag --sort=-v:refname | head -n 1)
if [ -z "$LATEST_TAG" ]; then
  err "No tags found in agent-orchestrator repository. This is unexpected."
  exit 1
fi
git -C "$INSTALL_DIR" checkout --quiet "$LATEST_TAG"
ok "Using stable release: $LATEST_TAG"

# ---------- install CLI command ----------
# Try ~/.local/bin first (no sudo needed), fall back to /usr/local/bin.
# The installer requires the Node.js CLI entrypoint and Node.js >= 18.
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

BIN_SOURCE="$INSTALL_DIR/bin/cli.js"
chmod +x "$BIN_SOURCE"

BIN_DIR=""
if [ -d "$HOME/.local/bin" ] && echo "$PATH" | grep -q "$HOME/.local/bin"; then
  BIN_DIR="$HOME/.local/bin"
elif [ -d "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
elif [ -w "/usr/local/bin" ]; then
  BIN_DIR="/usr/local/bin"
else
  mkdir -p "$HOME/.local/bin"
  BIN_DIR="$HOME/.local/bin"
fi

ln -sf "$BIN_SOURCE" "$BIN_DIR/$BIN_NAME"
ln -sf "$BIN_SOURCE" "$BIN_DIR/ao"
ok "Installed $BIN_NAME to $BIN_DIR/ (shorthand: ao)"

# ---------- PATH hint ----------
if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
  echo ""
  info "Add $BIN_DIR to your PATH:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi

# ---------- done ----------
echo ""
ok "agent-orchestrator installed successfully!"
echo ""
echo "  Next step: cd into your project and run:"
echo "    agent-orchestrator init  (or: ao init)"
echo ""
