#!/bin/sh
set -e

input=$(cat)
hook_command=$(
  printf '%s' "$input" | node -e '
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        process.stdout.write(payload.tool_input && payload.tool_input.command || "");
      } catch (error) {
        process.stdout.write("");
      }
    });
  ' 2>/dev/null
) || true

case "$hook_command" in
  git\ commit | git\ commit\ *) ;;
  *) exit 0 ;;
esac

script_dir=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
repo_root=$(
  CDPATH= cd -- "$script_dir/../.." && pwd
)

if sh "$repo_root/.github/hooks/check-version-format.sh"; then
  echo "Claude hook: version check passed."
  exit 0
else
  status=$?
fi

if [ "$status" -eq 1 ]; then
  echo "Claude hook: blocking git commit (version format error)."
  exit 2
fi

exit "$status"
