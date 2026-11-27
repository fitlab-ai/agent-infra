#!/bin/sh
# Ensure the labels matching --prefix on an issue or PR equal the set passed via
# repeated --target flags (0, 1, or N labels).
# Algorithm must stay in sync with .agents/rules/issue-sync.md.

set -e

usage() {
  printf 'Usage: %s --repo <owner/repo> (--issue <number> | --pr <number>) --prefix <prefix> [--target <label> ...]\n' "$0" >&2
  exit 1
}

append_target() {
  if [ -n "$targets" ]; then
    targets=$(printf '%s\n%s' "$targets" "$1")
  else
    targets=$1
  fi
}

repo=""
number=""
kind=""
prefix=""
targets=""
strict=false

run_gh() {
  if [ "$strict" = true ]; then
    gh "$@"
  else
    gh "$@" 2>/dev/null || true
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --strict)
      strict=true
      shift
      ;;
    --repo)
      [ $# -ge 2 ] || usage
      repo=$2
      shift 2
      ;;
    --issue)
      [ $# -ge 2 ] || usage
      [ -z "$kind" ] || usage
      kind="issue"
      number=$2
      shift 2
      ;;
    --pr)
      [ $# -ge 2 ] || usage
      [ -z "$kind" ] || usage
      kind="pr"
      number=$2
      shift 2
      ;;
    --prefix)
      [ $# -ge 2 ] || usage
      prefix=$2
      shift 2
      ;;
    --target)
      [ $# -ge 2 ] || usage
      append_target "$2"
      shift 2
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage
      ;;
  esac
done

[ -n "$repo" ] || usage
[ -n "$number" ] || usage
[ -n "$kind" ] || usage
[ -n "$prefix" ] || usage

while IFS= read -r label; do
  [ -z "$label" ] && continue
  case "$label" in
    "$prefix"*) ;;
    *)
      printf 'Target "%s" must start with prefix "%s"\n' "$label" "$prefix" >&2
      exit 1
      ;;
  esac
done <<EOF
$targets
EOF

current_labels=$(run_gh "$kind" view "$number" \
  --repo "$repo" \
  --json labels --jq ".labels[].name | select(startswith(\"$prefix\"))" )

while IFS= read -r label; do
  [ -z "$label" ] && continue
  if ! printf '%s\n' "$targets" | grep -qxF "$label"; then
    run_gh "$kind" edit "$number" \
      --repo "$repo" \
      --remove-label "$label"
  fi
done <<EOF
$current_labels
EOF

while IFS= read -r label; do
  [ -z "$label" ] && continue
  if ! printf '%s\n' "$current_labels" | grep -qxF "$label"; then
    run_gh "$kind" edit "$number" \
      --repo "$repo" \
      --add-label "$label"
  fi
done <<EOF
$targets
EOF
