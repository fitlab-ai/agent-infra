#!/bin/sh
set -e

INFRA_ROOT="$HOME/.agent-infra"
migrated=0
skipped=0
found_legacy=0

log_step() {
  printf '==> %s\n' "$1"
}

increment_migrated() {
  migrated=$((migrated + 1))
}

increment_skipped() {
  skipped=$((skipped + 1))
}

mark_found_legacy() {
  found_legacy=1
}

warn_running_containers() {
  project="$1"
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi

  containers=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
  if printf '%s\n' "$containers" | grep -q "^${project}-dev-"; then
    printf '  warning: running sandbox containers detected for %s; stop them before restarting migrated worktrees\n' "$project"
  fi
}

set_file_mode_if_exists() {
  mode="$1"
  file_path="$2"
  if [ -e "$file_path" ]; then
    chmod "$mode" "$file_path"
  fi
}

log_step "Checking for legacy sandbox paths"
for candidate in \
  "$HOME/.claude-sandboxes" \
  "$HOME/.codex-sandboxes" \
  "$HOME/.opencode-sandboxes" \
  "$HOME/.gemini-sandboxes" \
  "$HOME/.ai-sandbox-aliases" \
  "$HOME"/.*-worktrees \
  "$HOME"/.*-gpg-cache \
  "$HOME"/.*-claude-credentials
do
  if [ -e "$candidate" ]; then
    mark_found_legacy
    break
  fi
done

if [ "$found_legacy" -eq 0 ]; then
  printf 'Nothing to migrate.\n'
  exit 0
fi

mkdir -p "$INFRA_ROOT"

log_step "Migrating tool sandboxes"
for tool in claude codex opencode gemini; do
  target_id="$tool"
  case "$tool" in
    claude) target_id="claude-code" ;;
    gemini) target_id="gemini-cli" ;;
  esac

  legacy_root="$HOME/.${tool}-sandboxes"
  if [ ! -d "$legacy_root" ]; then
    continue
  fi

  for project_dir in "$legacy_root"/*; do
    if [ ! -d "$project_dir" ]; then
      continue
    fi

    project=$(basename "$project_dir")
    target_dir="$INFRA_ROOT/sandboxes/$target_id/$project"
    mkdir -p "$(dirname "$target_dir")"
    if [ -e "$target_dir" ]; then
      printf '  skip (exists): %s\n' "$target_dir"
      increment_skipped
      continue
    fi

    mv "$project_dir" "$target_dir"
    increment_migrated
  done

  rmdir "$legacy_root" 2>/dev/null || true
done

log_step "Migrating worktrees"
for legacy_dir in "$HOME"/.*-worktrees; do
  if [ ! -d "$legacy_dir" ]; then
    continue
  fi

  base_name=$(basename "$legacy_dir")
  project=${base_name#.}
  project=${project%-worktrees}
  target_dir="$INFRA_ROOT/worktrees/$project"

  warn_running_containers "$project"
  mkdir -p "$(dirname "$target_dir")"
  if [ -e "$target_dir" ]; then
    printf '  skip (exists): %s\n' "$target_dir"
    increment_skipped
    continue
  fi

  mv "$legacy_dir" "$target_dir"
  increment_migrated
  printf '  reminder: run "git -C <repo> worktree repair" for %s\n' "$project"
done

log_step "Migrating GPG cache"
for legacy_dir in "$HOME"/.*-gpg-cache; do
  if [ ! -d "$legacy_dir" ]; then
    continue
  fi

  base_name=$(basename "$legacy_dir")
  project=${base_name#.}
  project=${project%-gpg-cache}
  target_dir="$INFRA_ROOT/gpg-cache/$project"

  mkdir -p "$(dirname "$target_dir")"
  if [ -e "$target_dir" ]; then
    printf '  skip (exists): %s\n' "$target_dir"
    increment_skipped
    continue
  fi

  mv "$legacy_dir" "$target_dir"
  chmod 700 "$target_dir"
  set_file_mode_if_exists 600 "$target_dir/public.asc"
  set_file_mode_if_exists 600 "$target_dir/secret.asc"
  set_file_mode_if_exists 600 "$target_dir/state.json"
  increment_migrated
done

log_step "Migrating Claude credentials"
for legacy_dir in "$HOME"/.*-claude-credentials; do
  if [ ! -d "$legacy_dir" ]; then
    continue
  fi

  base_name=$(basename "$legacy_dir")
  project=${base_name#.}
  project=${project%-claude-credentials}
  target_dir="$INFRA_ROOT/credentials/$project/claude-code"

  mkdir -p "$(dirname "$target_dir")"
  if [ -e "$target_dir" ]; then
    printf '  skip (exists): %s\n' "$target_dir"
    increment_skipped
    continue
  fi

  mv "$legacy_dir" "$target_dir"
  chmod 700 "$target_dir"
  set_file_mode_if_exists 600 "$target_dir/.credentials.json"
  increment_migrated
done

log_step "Migrating sandbox aliases"
legacy_aliases="$HOME/.ai-sandbox-aliases"
target_aliases="$INFRA_ROOT/aliases/sandbox.sh"
if [ -f "$legacy_aliases" ]; then
  mkdir -p "$(dirname "$target_aliases")"
  if [ -e "$target_aliases" ]; then
    printf '  skip (exists): %s\n' "$target_aliases"
    increment_skipped
  else
    mv "$legacy_aliases" "$target_aliases"
    increment_migrated
  fi
fi

printf '\nMigration complete. migrated=%d skipped=%d\n' "$migrated" "$skipped"
printf 'Reminder: for each migrated project worktree, run\n'
printf '  git -C <repo> worktree repair\n'
