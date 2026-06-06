# Custom clipboard source

> macOS 剪贴板粘贴桥的进阶配置。基础桥接行为见 [README.zh-CN.md](../README.zh-CN.md) 的沙箱章节。English version: [clipboard.md](clipboard.md).

当 agent-infra 运行在另一台 Mac 上而图片实际复制在你手边的 Mac 上时，或当你想接入自定义/更快的剪贴板读取器、在测试中使用 mock PNG 源时，可以设置 `AGENT_INFRA_CLIPBOARD_READ_PNG`。它的值是可执行文件路径，不是 shell 命令：agent-infra 会直接无参数执行它，不展开 `~`，也不解析管道、重定向或 `"ssh macbook pngpaste -"` 这类内联命令串。请把命令写进脚本文件，再把 env var 指向该脚本的绝对路径。

该命令需要把 PNG 字节写到 stdout。退出码 0 表示有图片；非零退出表示没有图片或出错。读取会在 5 秒后超时，agent-infra 仍会校验 PNG magic bytes，确认有效后才注入沙箱。

沙箱会话启动时，agent-infra 会先用同一个命令做一次 2 秒可用性探活，探活通过后才启用桥接。对于基于 SSH 的脚本，这意味着会话启动会多一次连接和剪贴板读取；之后第一次 `Ctrl+V` 会再次读取。

远程 Mac 剪贴板读取示例：

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

可在 `~/.zprofile`、`~/.zshrc`、`~/.bashrc` 或 launchd plist 中设置：

```bash
export AGENT_INFRA_CLIPBOARD_READ_PNG="$HOME/.agent-infra/read-clip.sh"
```

请使用绝对路径。上面的 `export` 示例里 `$HOME` 由你的 shell 展开；launchd plist 的值不会经过 shell 展开，因此需要直接写展开后的绝对路径。

调试脚本本身时，运行 `/abs/path/read-clip.sh | file -`，确认输出包含 `PNG image data`。要确认 agent-infra 是否真的调用了脚本，可以临时在脚本里加 `echo "called $(date)" >> /tmp/clip.log`，然后在沙箱会话中按 `Ctrl+V` 查看日志。

一旦设置 `AGENT_INFRA_CLIPBOARD_READ_PNG`，agent-infra 就锁定外部源，不会 fallback 到本地 osascript。如果命令无法启动（`ENOENT`、`EACCES` 或 `ENOTDIR`），本次会话会禁用剪贴板桥，并把原始 `Ctrl+V` 转发给终端。该可执行文件会以 agent-infra 的权限运行；不要指向不可信文件，也不要在 root 或多用户场景信任来源不明的 env。
