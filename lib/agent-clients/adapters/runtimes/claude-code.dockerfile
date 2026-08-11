RUN cat > /usr/local/bin/cc-token-status <<'SCRIPT' && chmod +x /usr/local/bin/cc-token-status
#!/bin/sh
set -eu

SETTINGS_FILE="/home/devuser/.claude/settings.json"
if [ -r "$SETTINGS_FILE" ] && jq -e '
  def has_nonempty($v):
    if ($v | type) == "string" then ($v | gsub("^\\s+|\\s+$"; "") | length) > 0 else false end;
  (if type == "object" then . else {} end) as $settings
  | (if ($settings.env | type) == "object" then $settings.env else {} end) as $env
  | has_nonempty($env.ANTHROPIC_AUTH_TOKEN)
    or has_nonempty($env.ANTHROPIC_API_KEY)
    or has_nonempty($settings.apiKeyHelper)
' "$SETTINGS_FILE" >/dev/null 2>&1; then
  exit 0
fi

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

RUN test -s /usr/local/bin/cc-token-status && test -x /usr/local/bin/cc-token-status

RUN printf '%s\n' \
      "set -g status-right '#(/usr/local/bin/cc-token-status) | %H:%M'" \
    >> /etc/tmux.conf
