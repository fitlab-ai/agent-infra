#!/bin/sh

set -e

cleanup_stale_in=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cleanup-stale-in)
      cleanup_stale_in=true
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

node - "$cleanup_stale_in" <<'NODE'
const cleanupStaleIn = process.argv[2] === "true";
process.stdout.write(`${JSON.stringify({
  status: "degraded",
  operation: "init-labels",
  error: {
    code: "PLATFORM_LABELS_UNSUPPORTED",
    message: cleanupStaleIn
      ? "The current platform does not provide a label adapter; stale labels were not removed."
      : "The current platform does not provide a label adapter."
  }
})}\n`);
NODE
exit 0
