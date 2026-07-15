#!/bin/sh
set -e

script_dir=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
repo_root=$(
  CDPATH= cd -- "$script_dir/.." && pwd
)

airc_file="$repo_root/.agents/.airc.json"

if [ ! -f "$airc_file" ]; then
  exit 0
fi

template_version=$(
  node -e "const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (typeof data.templateVersion !== 'string') process.exit(1); process.stdout.write(data.templateVersion);" "$airc_file"
) || {
  echo "Error: Failed to read templateVersion from .agents/.airc.json."
  exit 1
}

if ! node -e '
  const version = process.argv[1];
  const semver = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  process.exit(semver.test(version) ? 0 : 1);
' "$template_version"; then
  echo "Error: .agents/.airc.json templateVersion must use v-prefixed semver (found: $template_version)."
  exit 1
fi

echo "Version format check passed."
