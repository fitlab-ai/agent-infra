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
  err "Node.js >= 22.9.0 is required but not found."
  err "Install Node.js: https://nodejs.org/"
  exit 1
fi

NODE_MIN_OK=$(node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 9) ? 0 : 1)' 2>/dev/null && echo 1 || echo 0)
if [ "$NODE_MIN_OK" != 1 ]; then
  err "Node.js >= 22.9.0 is required (current: $(node --version))."
  err "Please upgrade: https://nodejs.org/"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm is required but not found."
  err "npm is bundled with Node.js >= 22.9.0. Please reinstall Node.js: https://nodejs.org/"
  exit 1
fi

# ---------- install via npm ----------
info "Installing $NPM_PACKAGE via npm ..."
npm install -g "$NPM_PACKAGE"
ok "agent-infra installed successfully!"

# ---------- host-control service ----------
# The service is user-scoped and owns the fixed host-control endpoint used by
# task-control commands. If the platform service manager is unavailable, keep
# the installation usable for read-only commands while task-control fails
# closed until the service is started manually.
if command -v agent-infra-internal >/dev/null 2>&1; then
  case "$(uname -s)" in
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files >/dev/null 2>&1; then
        agent-infra-internal host-control install >/dev/null
        systemctl --user daemon-reload
        if systemctl --user enable agent-infra-host-control.service >/dev/null 2>&1 \
          && systemctl --user restart agent-infra-host-control.service >/dev/null 2>&1; then
          ok "host-control service enabled"
        else
          warn "host-control service was installed but could not be started; run: systemctl --user enable agent-infra-host-control.service && systemctl --user restart agent-infra-host-control.service"
        fi
      else
        warn "systemd user services are unavailable; task-control will fail closed until host-control is started manually."
      fi
      ;;
    Darwin)
      if command -v launchctl >/dev/null 2>&1; then
        agent-infra-internal host-control install >/dev/null
        launch_agent="$HOME/Library/LaunchAgents/com.fitlab-ai.agent-infra.host-control.plist"
        launch_domain="gui/$(id -u)"
        launchctl bootout "$launch_domain/com.fitlab-ai.agent-infra.host-control" >/dev/null 2>&1 || true
        # bootout can return before launchd releases the previous registration.
        launch_attempt=0
        until launchctl bootstrap "$launch_domain" "$launch_agent" >/dev/null 2>&1; do
          launch_attempt=$((launch_attempt + 1))
          if [ "$launch_attempt" -ge 30 ]; then
            err "host-control service could not be loaded; run: launchctl bootstrap $launch_domain $launch_agent"
            exit 1
          fi
          sleep 1
        done
        if launchctl kickstart -k "$launch_domain/com.fitlab-ai.agent-infra.host-control" >/dev/null 2>&1; then
          ok "host-control service enabled"
        else
          err "host-control service could not be started; run: launchctl kickstart -k $launch_domain/com.fitlab-ai.agent-infra.host-control"
          exit 1
        fi
      else
        warn "launchd is unavailable; task-control will fail closed until host-control is started manually."
      fi
      ;;
    *)
      warn "host-control service is unsupported on this platform; task-control will fail closed."
      ;;
  esac
fi

if [ "$(uname -s)" = "Linux" ] && ! command -v docker >/dev/null 2>&1; then
  warn "Note: 'ai sandbox' requires Docker Engine. See README 'Platform Support → Linux'."
fi

# ---------- done ----------
echo ""
echo "  Next step: cd into your project and run:"
echo "    agent-infra init  (or: ai init)"
echo ""
echo "  To update later:"
echo "    ai update"
echo ""
echo "  Alternative install (macOS):"
echo "    brew install fitlab-ai/tap/agent-infra"
echo ""
