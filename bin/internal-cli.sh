#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$script_dir/internal-cli.js" ]; then
  internal_cli="$script_dir/internal-cli.js"
else
  internal_cli="$script_dir/../dist/bin/internal-cli.js"
fi

command=${1-}
case "$command" in
  task-lifecycle|task-orchestration|task-finalization)
    if [ -d /run/agent-infra/control-status ] \
      && [ -z "${AGENT_INFRA_TASK_ID-}${AGENT_INFRA_CONTROL_TOKEN-}${AGENT_INFRA_CONTROL_GENERATION-}${AGENT_INFRA_CONTROL_DIR-}${AGENT_INFRA_CONTROL_STATUS_DIR-}${AGENT_INFRA_RUNTIME_DIR-}${AGENT_INFRA_EXECUTOR_MANIFEST-}" ]; then
      printf '%s\n' '{"status":"failed","changed":false,"error":{"code":"SANDBOX_CONTROL_IDENTITY_MISSING","message":"sandbox control identity is present but its launch configuration is missing"}}'
      exit 1
    fi
    ;;
esac

# The outer launcher owns the Node startup boundary. A task-bound process must
# not pass preload, import, or loader injection into the control router.
unset NODE_OPTIONS NODE_PATH
exec node "$internal_cli" "$@"
