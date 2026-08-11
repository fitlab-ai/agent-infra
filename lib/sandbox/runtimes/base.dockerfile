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
        if ubuntu_uid="$(id -u ubuntu 2>/dev/null)" && [ "${ubuntu_uid}" = "${HOST_UID}" ]; then \
            userdel -r ubuntu || exit 1; \
        fi; \
        (groupadd -g ${HOST_GID} devuser || true) && \
        useradd -u ${HOST_UID} -g ${HOST_GID} -m -s /bin/bash devuser; \
    fi

RUN --mount=type=secret,id=HTTP_PROXY \
    --mount=type=secret,id=HTTPS_PROXY \
    --mount=type=secret,id=NO_PROXY \
    export HTTP_PROXY="$(cat /run/secrets/HTTP_PROXY 2>/dev/null || true)" && \
    export HTTPS_PROXY="$(cat /run/secrets/HTTPS_PROXY 2>/dev/null || true)" && \
    export NO_PROXY="$(cat /run/secrets/NO_PROXY 2>/dev/null || true)" && \
    export http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" no_proxy="${NO_PROXY}" && \
    apt-get update && apt-get install -y \
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
      "set -g status-right '%H:%M'" \
    > /etc/tmux.conf

RUN cat > /usr/local/bin/sandbox-dotfiles-link <<'SCRIPT' && chmod +x /usr/local/bin/sandbox-dotfiles-link
#!/bin/sh
# Mirror /dotfiles/ tree as symlinks under $HOME/, overwriting any image-baked
# defaults. Future preferences only need to land in the host directory.
set -eu

DOTFILES_SRC=/dotfiles
[ -d "$DOTFILES_SRC" ] || exit 0

is_dotfiles_excluded() {
  candidate=$1
  case "$candidate" in
    .ssh|.ssh/*|\
    .gnupg|.gnupg/*|\
    .host-shell-config|.host-shell-config/*|\
    .gitconfig|.gitignore_global|.stCommitMsg|.bash_aliases|README.md)
      return 0 ;;
  esac

  [ -r /etc/agent-infra/dotfiles-exclusions ] || return 1
  while IFS= read -r prefix; do
    [ -n "$prefix" ] || continue
    case "$candidate" in
      "$prefix"|"$prefix"/*) return 0 ;;
    esac
  done < /etc/agent-infra/dotfiles-exclusions
  return 1
}

cd "$DOTFILES_SRC"
find . -type f -print | while IFS= read -r rel; do
  rel=${rel#./}
  target="$HOME/$rel"
  if is_dotfiles_excluded "$rel"; then
    continue
  fi

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

RUN test -s /usr/local/bin/sandbox-dotfiles-link && test -x /usr/local/bin/sandbox-dotfiles-link && \
    test -s /usr/local/bin/sandbox-tmux-entry && test -x /usr/local/bin/sandbox-tmux-entry

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

RUN ln -s /workspace /home/devuser/workspace
