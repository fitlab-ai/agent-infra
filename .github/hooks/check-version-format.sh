#!/bin/sh
set -e

script_dir=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
repo_root=$(
  CDPATH= cd -- "$script_dir/../.." && pwd
)

airc_file="$repo_root/.agent-infra/config.json"
package_file="$repo_root/package.json"

if [ ! -f "$airc_file" ] || [ ! -f "$package_file" ]; then
  exit 0
fi

template_version=$(
  node -e "const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (typeof data.templateVersion !== 'string') process.exit(1); process.stdout.write(data.templateVersion);" "$airc_file"
) || {
  echo "Error: Failed to read templateVersion from .agent-infra/config.json."
  exit 1
}

package_version=$(
  node -e "const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (typeof data.version !== 'string') process.exit(1); process.stdout.write(data.version);" "$package_file"
) || {
  echo "Error: Failed to read version from package.json."
  exit 1
}

if ! printf '%s\n' "$template_version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: .agent-infra/config.json templateVersion must use v-prefixed semver (found: $template_version)."
  echo "Fix: set .agent-infra/config.json.templateVersion to v$package_version"
  exit 1
fi

if ! printf '%s\n' "$package_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: package.json version must use plain semver without a v prefix (found: $package_version)."
  echo "Fix: set package.json.version to ${template_version#v}"
  exit 1
fi

if [ "${template_version#v}" != "$package_version" ]; then
  echo "Error: .agent-infra/config.json templateVersion and package.json version do not match."
  echo "Expected: templateVersion=v$package_version"
  echo "Actual: templateVersion=$template_version, version=$package_version"
  exit 1
fi

echo "Version format check passed."
