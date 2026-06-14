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

# Inject: Escape first to leave any non-input TUI state, then the resume text.
tmux send-keys -t "$TMUX_PANE" Escape 2>/dev/null
tmux send-keys -t "$TMUX_PANE" "$RESUME_TEXT" Enter 2>/dev/null
log "send-keys done (error=$error)"
exit 0
