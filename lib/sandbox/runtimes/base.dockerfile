FROM ubuntu:24.04

LABEL description="AI coding sandbox"

ENV DEBIAN_FRONTEND=noninteractive

ARG HOST_UID=1000
ARG HOST_GID=1000
# Root host uid 0 collides with container root; -o lets devuser share uid 0
# while keeping a real passwd entry that USER devuser can resolve.
RUN if [ "${HOST_UID}" = "0" ]; then \
        (groupadd -o -g ${HOST_GID} devuser || true) && \
        useradd -o -u ${HOST_UID} -g ${HOST_GID} -m -s /bin/bash devuser; \
    else \
        (groupadd -g ${HOST_GID} devuser || true) && \
        useradd -u ${HOST_UID} -g ${HOST_GID} -m -s /bin/bash devuser; \
    fi

RUN apt-get update && apt-get install -y \
    curl wget git vim file jq \
    build-essential ca-certificates gnupg lsb-release \
    libevent-core-2.1-7 libncursesw6 libtinfo6 \
    pkg-config bison libevent-dev libncurses-dev \
    locales tzdata \
    && locale-gen en_US.UTF-8 \
    && (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg) \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && TMUX_VERSION=3.6b \
    && wget -qO /tmp/tmux.tar.gz \
        "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
    && tar xzf /tmp/tmux.tar.gz -C /tmp \
    && cd /tmp/tmux-${TMUX_VERSION} \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && make install \
    && cd / \
    && rm -rf /tmp/tmux.tar.gz /tmp/tmux-${TMUX_VERSION} \
    && apt-get purge -y pkg-config bison libevent-dev libncurses-dev \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Enable extended keys in CSI u format so Shift+Enter and other modified
# keys are forwarded through tmux. Preserve terminal/timezone variables
# injected at `docker exec` time when new tmux sessions are created.
RUN printf '%s\n' \
      'set -g extended-keys always' \
      'set -g extended-keys-format csi-u' \
      "set -as terminal-features 'xterm*:extkeys'" \
      "set -ga update-environment 'TERM_PROGRAM TERM_PROGRAM_VERSION LC_TERMINAL LC_TERMINAL_VERSION TZ'" \
      'set -g mouse on' \
      'set -g status-interval 1' \
      'set -g status-right-length 80' \
      "set -g status-right '#(/usr/local/bin/cc-token-status) | %H:%M'" \
    > /etc/tmux.conf

RUN cat > /usr/local/bin/cc-token-status <<'SCRIPT' && chmod +x /usr/local/bin/cc-token-status
#!/bin/sh
set -eu

CRED_FILE="/home/devuser/.claude/.credentials.json"
[ -r "$CRED_FILE" ] || exit 0

EXPIRES_MS=$(jq -r '(.claudeAiOauth.expiresAt // .expiresAt) // empty' "$CRED_FILE" 2>/dev/null || true)
case "$EXPIRES_MS" in
  ''|*[!0-9]*) exit 0 ;;
esac

NOW_MS=$(($(date +%s) * 1000))
DIFF_MS=$((EXPIRES_MS - NOW_MS))
DIFF_S=$((DIFF_MS / 1000))

DIM='#[fg=colour245]'
YELLOW='#[fg=yellow]'
YELLOW_BOLD='#[fg=yellow,bold]'
RED_BOLD='#[fg=red,bold]'
RED_REV='#[fg=red,reverse]'
RESET='#[default]'

if [ "$DIFF_S" -le 0 ]; then
  ELAPSED=$(( -DIFF_S ))
  M=$((ELAPSED / 60))
  printf '%sClaude Code auth EXPIRED %dm ago%s' "$RED_REV" "$M" "$RESET"
elif [ "$DIFF_S" -lt 60 ]; then
  printf '%sClaude Code auth expires in %ds%s' "$RED_BOLD" "$DIFF_S" "$RESET"
elif [ "$DIFF_S" -lt 300 ]; then
  M=$((DIFF_S / 60))
  S=$((DIFF_S % 60))
  printf '%sClaude Code auth expires in %dm %ds%s' "$RED_BOLD" "$M" "$S" "$RESET"
elif [ "$DIFF_S" -lt 1800 ]; then
  M=$((DIFF_S / 60))
  printf '%sClaude Code auth expires in %dm%s' "$YELLOW_BOLD" "$M" "$RESET"
elif [ "$DIFF_S" -lt 3600 ]; then
  M=$((DIFF_S / 60))
  printf '%sClaude Code auth expires in %dm%s' "$YELLOW" "$M" "$RESET"
else
  TOTAL_M=$((DIFF_S / 60))
  H=$((TOTAL_M / 60))
  M=$((TOTAL_M % 60))
  printf '%sClaude Code auth expires in %dh %dm%s' "$DIM" "$H" "$M" "$RESET"
fi
SCRIPT

RUN cat > /usr/local/bin/sandbox-dotfiles-link <<'SCRIPT' && chmod +x /usr/local/bin/sandbox-dotfiles-link
#!/bin/sh
# Mirror /dotfiles/ tree as symlinks under $HOME/, overwriting any image-baked
# defaults. Future preferences only need to land in the host directory.
set -eu

DOTFILES_SRC=/dotfiles
[ -d "$DOTFILES_SRC" ] || exit 0

cd "$DOTFILES_SRC"
find . -type f -print | while IFS= read -r rel; do
  rel=${rel#./}
  target="$HOME/$rel"
  case "$rel" in
    .ssh|.ssh/*|\
    .gnupg|.gnupg/*|\
    .claude|.claude/*|\
    .codex|.codex/*|\
    .gemini|.gemini/*|\
    .config/opencode|.config/opencode/*|\
    .local/share/opencode|.local/share/opencode/*|\
    .host-shell-config|.host-shell-config/*|\
    .gitconfig|.gitignore_global|.stCommitMsg|.bash_aliases|README.md)
      continue ;;
  esac

  mkdir -p "$(dirname "$target")"
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    printf 'sandbox-dotfiles-link: skipping %s (existing directory; use nested path like %s/<file> instead)\n' "$target" "$rel" >&2
    continue
  fi

  ln -sfn "$DOTFILES_SRC/$rel" "$target" 2>/dev/null \
    || printf 'sandbox-dotfiles-link: failed to link %s\n' "$target" >&2
done
SCRIPT

RUN cat > /usr/local/bin/sandbox-tmux-entry <<'SCRIPT' && chmod +x /usr/local/bin/sandbox-tmux-entry
#!/bin/sh
set -eu

sandbox-dotfiles-link >/dev/null 2>&1 || true

SESSION=work

if ! command -v tmux >/dev/null 2>&1; then
  exec bash
fi

# Drop stale grouped sessions left by older entry-script versions (the windows
# live on $SESSION, so killing the group members only removes view entries).
tmux list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r name; do
    case "$name" in
      "$SESSION"-*) tmux kill-session -t "$name" 2>/dev/null || true ;;
    esac
done

# Reuse the single $SESSION; -d detaches any pre-existing client so the new
# one becomes the sole owner of window-size, eliminating size races.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  # Push the per-exec TZ into the running session's env so new
  # windows/panes pick up the host timezone without a session kill.
  if [ -n "${TZ:-}" ]; then
    tmux set-environment -t "$SESSION" TZ "$TZ" 2>/dev/null || true
  fi
  exec tmux attach -d -t "$SESSION"
fi

exec tmux new-session -s "$SESSION"
SCRIPT

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

RUN ln -s /workspace /home/devuser/workspace
