#!/bin/sh
# StopFailure hook: auto-resume Claude Code after a recoverable API error.
#
# Fires when a turn ends due to an API error. Runs four gates and, if all pass,
# injects a "please continue" message into the current tmux pane via send-keys.
# StopFailure output and exit code are ignored by Claude Code, so recovery is
# delivered out-of-band through tmux; every exit path here returns 0 and the
# only observable trace is the log file.
#
# Intentionally NOT using `set -e`: the network probe, tmux and state-file
# writes may fail locally without warranting an abort of the whole script.

LOG="$HOME/.claude/auto-resume.log"
STATE_DIR="$HOME/.claude/auto-resume.state"
WHITELIST="unknown server_error overloaded"
WINDOW=1800
MAX=10
PROBE_URL="https://api.anthropic.com/"
PROBE_DEADLINE=60
RESUME_TEXT="Unexpected interruption. Please continue the unfinished operation."

log() {
  mkdir -p "$HOME/.claude" 2>/dev/null
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$1" >> "$LOG"
  lines=$(wc -l < "$LOG" 2>/dev/null | tr -cd '0-9')
  [ -z "$lines" ] && lines=0
  if [ "$lines" -gt 5000 ]; then
    tail -n 2500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
}

# Read the StopFailure payload once, then extract session_id and error. The
# `error` field identifies the API error type and drives the whitelist gate.
payload=$(cat)
session_id=$(printf '%s' "$payload" | node -e 'let c=[];process.stdin.on("data",d=>c.push(d));process.stdin.on("end",()=>{try{const p=JSON.parse(Buffer.concat(c).toString());process.stdout.write(String(p.session_id||""))}catch{process.stdout.write("")}})' 2>/dev/null)
error=$(printf '%s' "$payload" | node -e 'let c=[];process.stdin.on("data",d=>c.push(d));process.stdin.on("end",()=>{try{const p=JSON.parse(Buffer.concat(c).toString());process.stdout.write(String(p.error||""))}catch{process.stdout.write("")}})' 2>/dev/null)

# Gate 1: only act inside a tmux pane; stay silent everywhere else.
if [ -z "$TMUX_PANE" ]; then
  log "not in tmux, skip (error=$error)"
  exit 0
fi

# Gate 2: only recover from the whitelisted, retriable error types.
case " $WHITELIST " in
  *" $error "*) : ;;
  *) log "blocked: non-recoverable error=$error"; exit 0 ;;
esac

# Gate 3: back off after MAX fires within a WINDOW-second sliding window per session.
mkdir -p "$STATE_DIR" 2>/dev/null
# Treat the payload session_id as untrusted: sanitize to a safe filename so a
# value like "../outside" cannot write the state file outside STATE_DIR.
safe_session=$(printf '%s' "${session_id:-nosession}" | tr -c 'A-Za-z0-9._-' '_')
f="$STATE_DIR/$safe_session.count"
now=$(date +%s)
if [ -f "$f" ]; then
  awk -v n="$now" -v w="$WINDOW" '$1 > n - w' "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
fi
# BSD `wc -l` (macOS) pads the count with leading spaces; strip to bare digits
# so the integer compare and the log line stay portable across GNU/BSD.
count=$( [ -f "$f" ] && wc -l < "$f" 2>/dev/null | tr -cd '0-9' || echo 0 )
[ -z "$count" ] && count=0
if [ "$count" -ge "$MAX" ]; then
  log "backoff: $count fires in 30m, skip (error=$error)"
  exit 0
fi
echo "$now" >> "$f"

# Gate 4: wait until the API is reachable again, up to PROBE_DEADLINE seconds.
# No --fail: any HTTP response (incl. 401/404) proves TLS/network connectivity.
waited=0
until curl -s -o /dev/null --max-time 3 "$PROBE_URL"; do
  waited=$((waited + 3))
  if [ "$waited" -ge "$PROBE_DEADLINE" ]; then
    log "probe timeout after ${waited}s, skip (error=$error)"
    exit 0
  fi
  sleep 3
done
log "probe ok after ${waited}s (error=$error)"

# Inject the resume message with a deliberately timing-insensitive sequence:
#   1. Escape leaves any non-input TUI state.
#   2. A 1s settle covers every known TUI escape timeout (vim 1000ms,
#      xterm/readline 50ms) so the next bytes are delivered as fresh input
#      instead of being folded into the escape sequence (the dropped-`U` race).
#   3. The text travels through a NAMED paste buffer pasted with bracketed
#      paste (-p): the TUI ingests it as a single paste rather than per-character
#      keypresses, so no leading char is eaten and the body is not read as a
#      submit. The named buffer (-b) guarantees we paste exactly this text, and
#      -d deletes it afterward so the user's anonymous paste stack is untouched.
#   4. Enter is a separate send-keys after the paste, so the submit signal is
#      never merged into the pasted content (the must-press-Enter race).
# Every step stays non-blocking (2>/dev/null, exit 0 below) and logs a WARN on
# failure so the log can localize which tmux step broke.
log "tmux inject start (error=$error)"
tmux send-keys -t "$TMUX_PANE" Escape 2>/dev/null || log "WARN: tmux Escape failed (error=$error)"
sleep 1
tmux set-buffer -b auto-resume -- "$RESUME_TEXT" 2>/dev/null || log "WARN: tmux set-buffer failed (error=$error)"
tmux paste-buffer -t "$TMUX_PANE" -b auto-resume -p -d 2>/dev/null || log "WARN: tmux paste-buffer failed (error=$error)"
tmux send-keys -t "$TMUX_PANE" Enter 2>/dev/null || log "WARN: tmux Enter failed (error=$error)"
log "tmux inject done (error=$error)"
exit 0
