#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
internal_cli=$script_dir/../dist/bin/internal-cli.js
launcher_auth_dir=${HOME:-/tmp}/.agent-infra
launcher_auth_path=$launcher_auth_dir/launcher-authority
if [ ! -f "$launcher_auth_path" ]; then
  umask 077
  mkdir -p "$launcher_auth_dir"
  od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]' > "$launcher_auth_path"
fi
launcher_key=$(cat "$launcher_auth_path")
launcher_nonce=$(od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]')
exec 9<<EOF
agent-infra-launcher-v1:$$:${launcher_key}:${launcher_nonce}
EOF
export AGENT_INFRA_TRUSTED_LAUNCHER_FD=9
unset NODE_OPTIONS NODE_PATH
exec node "$internal_cli" "$@"
