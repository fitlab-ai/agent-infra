# Custom clipboard source

> Advanced configuration for the macOS clipboard paste bridge. For the basic bridge behavior, see the sandbox section in the [README](../README.md). 中文版见 [clipboard.zh-CN.md](clipboard.zh-CN.md)。

Set `AGENT_INFRA_CLIPBOARD_READ_PNG` when agent-infra runs on a different Mac from the one where you copy images, when you want a custom or faster clipboard reader, or when tests need a mock PNG source. The value is an executable file path, not a shell command: agent-infra runs it directly with no arguments, does not expand `~`, and does not parse pipes, redirects, or inline commands such as `"ssh macbook pngpaste -"`. Put command lines in a script file and point the env var at that file's absolute path.

The command must write PNG bytes to stdout. Exit code 0 means an image is present; a non-zero exit means no image or an error. Reads time out after 5 seconds, and agent-infra still validates the PNG magic bytes before injecting anything into the sandbox.

When a sandbox session starts, agent-infra runs the same command once with a 2-second availability probe before the bridge is enabled. For SSH-backed scripts, expect one extra connection and clipboard read at session startup; the next `Ctrl+V` reads again.

Example remote Mac clipboard reader:

```bash
#!/usr/bin/env bash
# read-clip.sh - emit the clipboard image of the Mac you actually use as PNG on stdout.
# Point AGENT_INFRA_CLIPBOARD_READ_PNG at this file's absolute path (chmod +x first).
# Exit 0 + PNG on stdout = image present; non-zero exit = no image.
set -euo pipefail
# Requires key-based SSH (BatchMode, no password prompt) and `pngpaste`
# installed on the remote Mac: brew install pngpaste
exec ssh -o BatchMode=yes macbook 'pngpaste -'
# `pngpaste -` writes the clipboard image as PNG to stdout and exits non-zero
# when the clipboard holds no image; agent-infra reads that as "nothing to paste".
```

Set the env var from `~/.zprofile`, `~/.zshrc`, `~/.bashrc`, or a launchd plist:

```bash
export AGENT_INFRA_CLIPBOARD_READ_PNG="$HOME/.agent-infra/read-clip.sh"
```

Use an absolute path. `$HOME` is expanded by your shell in the `export` example above; launchd plist values do not get shell expansion, so write the already-expanded path there.

To debug the script itself, run `/abs/path/read-clip.sh | file -` and check for `PNG image data`. To confirm agent-infra calls it, temporarily add `echo "called $(date)" >> /tmp/clip.log` to the script and press `Ctrl+V` in the sandbox session.

When `AGENT_INFRA_CLIPBOARD_READ_PNG` is set, the external source is locked in and agent-infra does not fall back to local osascript. If the command cannot be started (`ENOENT`, `EACCES`, or `ENOTDIR`), the clipboard bridge is disabled for that session and the original `Ctrl+V` is forwarded to the terminal. The executable runs with agent-infra's permissions, so do not point it at untrusted files or trust untrusted env values in root or multi-user contexts.
