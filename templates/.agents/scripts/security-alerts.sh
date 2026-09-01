#!/bin/sh

set -e

operation="${1:-}"

node - "$operation" <<'NODE'
const operation = process.argv[2] || "";
const known = new Set([
  "read-dependabot",
  "dismiss-dependabot",
  "read-codescan",
  "dismiss-codescan"
]);
const payload = known.has(operation)
  ? {
      status: "degraded",
      operation,
      error: {
        code: "PLATFORM_SECURITY_UNSUPPORTED",
        message: "The current platform does not provide a security alert adapter."
      }
    }
  : {
      status: "failed",
      operation,
      error: { code: "SECURITY_OPERATION_INVALID", message: "Unknown security alert operation." }
    };
process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exit(known.has(operation) ? 0 : 1);
NODE
