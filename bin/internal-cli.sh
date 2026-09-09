#!/bin/sh
set -eu

script_path=$0
case "$script_path" in
  [A-Za-z]:*)
    drive=${script_path%"${script_path#?}"}
    drive=$(printf '%s' "$drive" | tr '[:upper:]' '[:lower:]')
    script_path="/${drive}${script_path#?:}"
    script_path=$(printf '%s' "$script_path" | tr '\\' '/')
    ;;
  /*) ;;
  *) script_path=$PWD/$script_path ;;
esac
while [ -L "$script_path" ]; do
  link_target=$(readlink "$script_path")
  case "$link_target" in
    /*) script_path=$link_target ;;
    *) script_path=$(dirname -- "$script_path")/$link_target ;;
  esac
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd -P)
if [ -f "$script_dir/internal-cli.js" ]; then
  internal_cli="$script_dir/internal-cli.js"
else
  internal_cli="$script_dir/../dist/bin/internal-cli.js"
fi

command=${1-}
task_control_command=false
case "$command" in
  task-lifecycle|task-orchestration|task-finalization) task_control_command=true ;;
esac

status_mount_present=false
if [ -d /run/agent-infra/control-status ]; then status_mount_present=true; fi
launch_config=${AGENT_INFRA_TASK_ID-}${AGENT_INFRA_CONTROL_TOKEN-}${AGENT_INFRA_CONTROL_GENERATION-}${AGENT_INFRA_CONTROL_DIR-}${AGENT_INFRA_CONTROL_STATUS_DIR-}${AGENT_INFRA_RUNTIME_DIR-}${AGENT_INFRA_EXECUTOR_MANIFEST-}
if [ "$task_control_command" = true ] && [ "$status_mount_present" = true ] && [ -z "$launch_config" ] && [ -z "${AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT-}" ]; then
  printf '%s\n' '{"status":"failed","changed":false,"error":{"code":"SANDBOX_CONTROL_IDENTITY_MISSING","message":"sandbox control identity is present but its launch configuration is missing"}}'
  exit 1
fi
# The outer launcher owns the Node startup boundary. A task-bound process must
# not pass preload, import, or loader injection into the control router.
unset NODE_OPTIONS NODE_PATH
exec node "$internal_cli" "$@"
