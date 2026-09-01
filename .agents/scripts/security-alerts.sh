#!/bin/sh

set -e

operation="${1:-}"
shift || true
number=""
reason=""
comment_file=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --number)
      number="${2:-}"
      shift
      ;;
    --reason)
      reason="${2:-}"
      shift
      ;;
    --comment-file)
      comment_file="${2:-}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

emit_error() {
  code="$1"
  message="$2"
  node - "$operation" "$code" "$message" <<'NODE'
const [operation, code, message] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ status: "failed", operation, error: { code, message } })}\n`);
NODE
}

case "$operation" in
  read-dependabot|dismiss-dependabot|read-codescan|dismiss-codescan) ;;
  *)
    emit_error "SECURITY_OPERATION_INVALID" "Unknown security alert operation."
    exit 1
    ;;
esac

case "$number" in
  ''|*[!0-9]*)
    emit_error "SECURITY_NUMBER_INVALID" "Alert number must be a positive integer."
    exit 1
    ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  emit_error "PLATFORM_CLI_MISSING" "The platform CLI is not installed."
  exit 1
fi
if ! gh auth token >/dev/null 2>&1; then
  emit_error "PLATFORM_NOT_AUTHENTICATED" "The platform CLI is not authenticated."
  exit 1
fi
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')" || {
  emit_error "PLATFORM_REPOSITORY_UNAVAILABLE" "Unable to access the current repository."
  exit 1
}

case "$operation" in
  *dependabot*) endpoint="repos/$repo/dependabot/alerts/$number" ;;
  *codescan*) endpoint="repos/$repo/code-scanning/alerts/$number" ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

if [ "$operation" = "read-dependabot" ] || [ "$operation" = "read-codescan" ]; then
  if ! gh api "$endpoint" > "$tmpdir/response.json" 2> "$tmpdir/error.txt"; then
    emit_error "SECURITY_API_FAILED" "Unable to read the security alert."
    exit 2
  fi
else
  if [ -z "$reason" ] || [ -z "$comment_file" ] || [ ! -f "$comment_file" ]; then
    emit_error "SECURITY_DISMISS_INPUT_INVALID" "Dismissal reason and comment file are required."
    exit 1
  fi
  if ! gh api "$endpoint" > "$tmpdir/current.json" 2> "$tmpdir/error.txt"; then
    emit_error "SECURITY_API_FAILED" "Unable to read the security alert before dismissal."
    exit 2
  fi
  state="$(node - "$tmpdir/current.json" <<'NODE'
const fs = require("node:fs");
try {
  const alert = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  process.stdout.write(typeof alert.state === "string" ? alert.state : "invalid");
} catch {
  process.stdout.write("invalid");
}
NODE
)"
  case "$state" in
    open) ;;
    dismissed|fixed)
      node - "$operation" "$tmpdir/current.json" <<'NODE'
const fs = require("node:fs");
const [operation, responsePath] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(responsePath, "utf8"));
process.stdout.write(`${JSON.stringify({ status: "no-op", operation, data })}\n`);
NODE
      exit 0
      ;;
    *)
      emit_error "SECURITY_RESPONSE_INVALID" "The platform returned an alert without a valid state."
      exit 1
      ;;
  esac
  node - "$reason" "$comment_file" > "$tmpdir/payload.json" <<'NODE'
const fs = require("node:fs");
const [reason, commentFile] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  state: "dismissed",
  dismissed_reason: reason,
  dismissed_comment: fs.readFileSync(commentFile, "utf8")
}));
NODE
  if ! gh api --method PATCH "$endpoint" --input "$tmpdir/payload.json" > "$tmpdir/response.json" 2> "$tmpdir/error.txt"; then
    emit_error "SECURITY_API_FAILED" "Unable to dismiss the security alert."
    exit 2
  fi
fi

node - "$operation" "$tmpdir/response.json" <<'NODE'
const fs = require("node:fs");
const [operation, responsePath] = process.argv.slice(2);
const raw = fs.readFileSync(responsePath, "utf8").trim();
let data = null;
if (raw) {
  try {
    data = JSON.parse(raw);
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "failed",
      operation,
      error: { code: "SECURITY_RESPONSE_INVALID", message: "The platform returned invalid JSON." }
    })}\n`);
    process.exit(1);
  }
}
process.stdout.write(`${JSON.stringify({ status: "applied", operation, data })}\n`);
NODE
