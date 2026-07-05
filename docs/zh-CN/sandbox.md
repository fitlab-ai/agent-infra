# 沙箱

[← 返回 README](../../README.zh-CN.md) · [English](../en/sandbox.md)

## 沙箱 aliases 与 GitHub CLI

`ai sandbox create` 在首次运行时会自动生成宿主机侧的 `~/.agent-infra/aliases/sandbox.sh`。该文件内置了 Claude、Codex、Gemini CLI 和 OpenCode 的 yolo 快捷命令模板，你可以直接修改；每次创建沙箱时，这个文件都会同步到容器内的 `/home/devuser/.bash_aliases`。

默认沙箱镜像也会安装 agent-infra CLI npm 包，并把 `ai` 与 `agent-infra` 暴露在容器 `PATH` 上。因此 `ai task decisions <task-ref>` 这类任务命令可以在沙箱内直接针对挂载的 `/workspace` 执行。已有沙箱镜像和容器需要刷新重建并重新创建后，才会获得这个新增的托管工具。

沙箱镜像也会预装 `gh`。如果宿主机上的 `gh auth token` 能成功返回 token，`ai sandbox create` 会把它以 `GH_TOKEN` 环境变量注入容器，让你在沙箱里直接使用 `gh`，无需额外登录配置。

`ai sandbox rebuild` 默认保留 Docker build cache，因此会快速重打沙箱镜像，不会刷新每个软件包。需要升级镜像时使用 `ai sandbox rebuild --refresh`：它会向 Docker 传入 `--no-cache --pull`，重新拉取当前 Ubuntu 基础镜像，并重跑 apt、tmux 编译和全局 npm 安装层。容器内 Claude Code 更新已关闭，OpenCode 启动时更新检查也已关闭；`--refresh` 是沙箱托管工具的常规升级入口。手动 `opencode upgrade` 不受该保护覆盖。Ubuntu 24.04 沙箱基础镜像提供的默认 `python3` 是 Python 3.12，因此硬编码 Python 3.10 路径的脚本可能需要调整。

`ai sandbox exec` 也会向容器透传一小组终端检测白名单变量（`TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`LC_TERMINAL`、`LC_TERMINAL_VERSION`）。这样可以让交互式 TUI 保持与宿主终端一致的行为，例如 Claude Code 的 `Shift+Enter` 换行支持，同时避免把整个宿主环境灌入容器。

`ai sandbox start <branch | TASK-id | N | '#N'>` 用于恢复已停止的沙箱容器——典型场景是宿主机 Docker daemon 被重启或替换（例如在已有 Docker 上安装 OrbStack 接管），导致容器变成 `Exited`。它只启动「已存在且已停止」的容器；容器不存在时会提示改用 `ai sandbox create`，已在运行的容器则保持不动。`ai sandbox exec <branch>` 会自动执行同样的恢复：当目标容器存在但已停止时，先启动容器再进入。由于每个 worktree 和各 AI 的 state 目录都持久化在宿主机，重启已停止的容器是安全的，不会丢失数据。

`ai sandbox ls` 保持精简：只列出当前项目的 Containers 容器表（`#` 行号、`SHORT` 任务短号，以及名称、状态、分支），不再打印 worktree 列表和各工具的 state 路径。要查看某个沙箱的这些详情，使用 `ai sandbox show <branch | TASK-id | N | '#N'>`：它会打印该分支的 worktree 路径和各工具（Claude Code、Codex、Gemini CLI、OpenCode）的 state 路径。入参契约与 `ai sandbox exec`、`ai sandbox start` 一致，因此 `ai sandbox show 11` 与 `ai sandbox show '#11'` 都会通过 `.agents/workspace/active/.short-ids.json` 解析当前任务短号。

在 macOS 上，交互式 `ai sandbox exec <branch>` 会尽力桥接宿主图片粘贴。当你按下 `Ctrl+V` 且宿主剪贴板当前是图片时，agent-infra 会从宿主剪贴板读取图片，将 PNG 写到 `~/.agent-infra/clipboard/`，再以 bracketed paste 注入容器内路径，让 Claude Code、Codex、Gemini CLI 和 OpenCode 按图片附件处理。宿主剪贴板只读，不会被改写。该能力会自动降级：已有沙箱需要重建后才有 `/clipboard` 挂载；如果可选 pty 依赖或剪贴板探测不可用，会回退到原本的交互进入方式。排查鼠标、滚动或其他输入异常时，可以设置 `AI_SANDBOX_NO_CLIPBOARD_BRIDGE=1` 跳过桥接，直接进入原本的交互路径。

当你通过 SSH 在远端 Mac 上运行沙箱时，可先在手边这台 Mac 上执行 `ai cp <ssh-alias>`，把本机剪贴板图片推送到远端 Mac。典型流程是：Cmd+C 复制图片，运行 `ai cp mini`，回到已有 SSH session 后按 `Ctrl+V`；沙箱桥会读取远端 Mac 的 NSPasteboard，并按原路径注入图片。该命令只处理 PNG 图片，并使用基于 ssh key 的非交互 ssh/scp。目前发送端与远端都需为 macOS（远端通过 `osascript` 写入 NSPasteboard），后续可扩展支持其他远端平台。

`ai sandbox exec` 和 `ai sandbox refresh` 会在宿主机凭证存储与 `~/.agent-infra/credentials/*` 下的所有沙箱项目副本之间做双向 reconcile。长时间运行的沙箱如果先刷新了 OAuth token，下一次进入或刷新命令会把最新有效副本回写到宿主 Keychain 或 `~/.claude/.credentials.json`；宿主机更新时也会继续覆盖项目副本。如果所有副本都已失效，`ai sandbox refresh` 会尝试 `claude /status` 探活，只有探活无法恢复时才提示重新登录。

启用 Claude Code 时，`ai sandbox create` 还会把宿主机 `~/.claude/settings.json` 中的模型和 API provider 设置合并到沙箱内的 Claude Code settings。已有的沙箱值优先，因此沙箱内的本地覆盖会被保留。凭证仍使用上面的专用 credentials 通道；provider 环境设置只会作为 Claude Code settings 值复制。

## 宿主-沙箱文件交换

`ai sandbox create` 会自动挂载两个可读写目录，方便宿主与容器之间互相 drop 文件，不污染 git 工作树：

- `/share/common` <- `~/.agent-infra/share/<project>/common/`：项目级共享，跨分支可见。
- `/share/branch` <- `~/.agent-infra/share/<project>/branches/<branch>/`：分支独占。
- `/clipboard` <- `~/.agent-infra/clipboard/`：macOS 图片粘贴桥接使用的只读存储。

这两条路径硬编码，不暴露 `.airc.json` 配置项。首次 `create` 时会自动创建宿主目录；执行 `ai sandbox rm <branch>` 删除时会附带询问是否清理（默认 yes）。`ai sandbox rm --all` 批量删除所有**未绑定 active 任务**的沙箱（即 `ai sandbox ls` 中短号为 `-` 的行）；可加 `--dry-run` 预览，或 `--yes` 跳过确认（非交互 shell 中必须显式传 `--yes`）。`ai sandbox rm --purge` 则拆除项目的**全部**沙箱（容器、worktree、镜像、VM）。**破坏性变更**：此前 `--all` 的语义即现在 `--purge` 的全量拆除。
可先用 `ai sandbox prune --dry-run` 查看旧版本或异常中断遗留的孤儿 per-branch 状态目录，再用 `ai sandbox prune` 只删除没有活跃 sandbox 容器对应的目录。
已有沙箱需要执行 `ai sandbox rm <branch>` 后再执行 `ai sandbox create <branch>`，才能加载新的挂载点。

首次执行 `ai sandbox create` 时，agent-infra 会在
`~/.agent-infra/share/<project>/common/` 以及每个 `branches/<branch>/`
目录下写入一份中英双语 `README.md`，帮助你发现这些通道。README 是幂等的，
可以安全删除；scaffold 仅在文件缺失时写入。

## 用户级 dotfiles 通道

`ai sandbox create` 还会自动挂载一条可选的只读通道，用于把宿主机用户级偏好带进沙箱：

- `/dotfiles` <- `~/.agent-infra/dotfiles/`：只读，host 作为单向源。

host 端目录树镜像容器 `$HOME` 下的预期路径，风格类似 GNU stow 或 chezmoi：

```text
~/.agent-infra/dotfiles/
├── .tmux.conf
└── .config/
    ├── lazygit/config.yml
    └── yazi/yazi.toml
```

每次进入沙箱时，`sandbox-dotfiles-link` 会用 `ln -sfn` 把每个文件链接到
`$HOME/<相对路径>`，覆盖镜像默认。host 端目录不存在时，会跳过挂载和链接步骤。

未来要加 `starship.toml`、`.gitconfig.local` 等偏好，只需把文件放进
`~/.agent-infra/dotfiles/`，无需修改 Dockerfile 或 `ai sandbox create`。

### 符号链接作为指向 host 文件的指针

你可以在 `~/.agent-infra/dotfiles/` 里放符号链接，让它们指向 host 上的真实文件：

```bash
ln -s ~/.tmux.conf ~/.agent-infra/dotfiles/.tmux.conf
ln -s ~/.config/lazygit ~/.agent-infra/dotfiles/.config/lazygit
```

每次执行 `ai sandbox create` 和 `ai sandbox enter` 前，agent-infra 会先把
dotfiles 树解引用到
`~/.agent-infra/.cache/dotfiles-resolved/<project>/`，再把这份快照挂载进容器。
因此修改 host 源文件后，重新进入沙箱即可看到最新内容。

悬空符号链接会被跳过并在 stderr 输出警告。符号链接循环以及超过 32 层的深层目录也会被跳过并输出警告。指向 `$HOME` 之外的符号链接可以使用，只要 host 用户能读取目标。

> **不要往 `~/.agent-infra/dotfiles/` 放任何凭证。** 容器内是只读挂载，但整棵偏好树会链入所有项目沙箱。不要放 `.ssh/`、`.aws/credentials`、`.netrc`、`.gnupg/`、包含 `_authToken` 的 `.npmrc`、任何 AI 工具 OAuth/access token 文件，也不要放 `.gitconfig`。SSH 和工具凭证请使用专用通道；本地 Git 偏好建议用 `.gitconfig.local` 配合 `[include]`。

**受保护路径**即使出现在 `~/.agent-infra/dotfiles/` 下，也会被钩子忽略：

| 路径模式 | 原因 |
|---|---|
| `.ssh/*` | host SSH 凭证由只读 SSH 挂载管理。 |
| `.gnupg/*` | GPG 私钥由 `gpg-agent` 管理。 |
| `.claude/*`, `.codex/*`, `.gemini/*` | AI 工具凭证使用专用 bind mount。 |
| `.config/opencode/*`, `.local/share/opencode/*` | OpenCode 凭证和数据使用专用 bind mount。 |
| `.host-shell-config/*` | agent-infra 管理的 shell 和 Git 配置。 |
| `.gitconfig`, `.gitignore_global`, `.stCommitMsg`, `.bash_aliases` | agent-infra 将这些路径软链到 `.host-shell-config/`，包含 `safe.directory` 和 GPG 同步状态。 |
| `README.md` | agent-infra 会在 dotfiles 根目录 scaffold 一份发现性 README；link hook 会忽略它，避免遮蔽 `$HOME/README.md`。 |

其他已经存在的真实目录（如 `~/.config/`、`~/.cache/`）不会被顶层 dotfile 替换。如果某个文件与这类目录冲突，钩子会打印警告并跳过：

```text
sandbox-dotfiles-link: skipping /home/devuser/.config (existing directory; use nested path like .config/<file> instead)
```

正确用法是嵌套路径，例如 `~/.agent-infra/dotfiles/.config/lazygit/config.yml`，不要把 `.config` 当成顶层文件。
