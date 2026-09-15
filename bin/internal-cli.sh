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

# The outer launcher owns the Node startup boundary. A task-bound process must
# not pass preload, import, or loader injection into the control router.
unset NODE_OPTIONS NODE_PATH
exec node "$internal_cli" "$@"
