# 沙箱

[← 返回 README](../../README.zh-CN.md) · [English](../en/sandbox.md)

## 构建前置条件与排障

创建和重建沙箱需要 Docker Buildx，以及可用的 BuildKit builder。agent-infra 会在检查或构建镜像之前，针对所选引擎和 Docker context 执行：

```bash
docker buildx inspect --bootstrap
```

如果检测失败，`ai sandbox create` 和 `ai sandbox rebuild` 会在 `docker build` 之前停止，并输出修复指引。Colima 用户可执行 `brew install docker-buildx` 安装缺失插件；首次安装 Colima 时会一并安装 `colima`、`docker` 和 `docker-buildx`。Docker Desktop 或 WSL2 用户应升级或修复 Docker Desktop；原生 Docker Engine 用户应安装当前发行版提供的 Buildx CLI 插件；OrbStack builder 不可用时应升级或修复 OrbStack。

内置镜像还会在 Docker 构建期间验证 `cc-token-status`、`sandbox-dotfiles-link` 与 `sandbox-tmux-entry` 均非空且可执行，因此 legacy builder 生成空脚本时构建不会成功。自定义 Dockerfile 仍需满足 BuildKit 前置条件，但不要求包含这三个内置脚本。

## PID 1 与孤儿进程回收

每个新建沙箱都会启用 Docker 托管的 init（`docker run --init`）。该 init 进程作为 PID 1 负责转发信号并回收孤儿子进程，避免反复运行构建、测试和 detached 工作时持续累积僵尸进程。此设置只在创建或显式重建容器时生效；存量容器会继续使用原来的 PID 1，需执行以下命令重建：

```bash
ai sandbox start --recreate <task-ref-or-branch>
```

重建会保留工作树、任务绑定、挂载和 `/share` 数据，但会替换容器内的进程状态。

## 沙箱 aliases 与 GitHub CLI

`ai sandbox create` 在首次运行时会自动生成宿主机侧的 `~/.agent-infra/aliases/sandbox.sh`。该文件内置了 Claude、Codex、Antigravity CLI 和 OpenCode 的 yolo 快捷命令模板，你可以直接修改；每次创建沙箱时，这个文件都会同步到容器内的 `/home/devuser/.bash_aliases`。

默认沙箱镜像也会安装 agent-infra CLI npm 包，并把 `ai` 与 `agent-infra` 暴露在容器 `PATH` 上。在任务绑定 worktree 中，生命周期技能和适用的任务命令会从当前 symbolic branch 严格反查 `task.md.branch` 完全匹配的唯一 active task；可用 `--task <ref>` / `-t <ref>` 显式选择其他任务，位置 task ref 会被拒绝。带其他位置操作数的命令使用无歧义形式，例如 `ai task cat analysis`、`ai task decisions --item 1` 和 `ai decide --item PL-1 <decision>`。`ai task grep <pattern>` 也只解析当前分支唯一任务；需要选择其他任务时使用 `--task <ref>`。宿主侧 `ai run` 使用 `--skill <skill> --task <task-ref>` 选择目标分支与 sandbox；`create-task` 使用 `--skill create-task <description>`。已有沙箱镜像和容器需要刷新重建并重新创建后，才会获得这个新增的托管工具。

沙箱镜像也会预装 `gh`。如果宿主机上的 `gh auth token` 能成功返回 token，`ai sandbox create` 会把它以 `GH_TOKEN` 环境变量注入容器，让你在沙箱里直接使用 `gh`，无需额外登录配置。

宿主机 `~/.ssh` 不会 bind mount 到沙箱中。GitHub 访问默认走上面的 `gh` / HTTPS token 路径；`git@github.com:*` 这类 SSH workflow 需要在默认沙箱边界之外另行显式配置。

## Agent Client 能力

canonical `agentClients` 条目决定哪些 Agent Client 会在沙箱内安装和挂载。
`installInSandbox` 与 `enabled` 相互独立：前者控制沙箱能力，后者控制项目
资产与集成。

```json
{
  "agentClients": [
    { "id": "claude-code", "enabled": true, "installInSandbox": false },
    { "id": "codex", "enabled": true, "installInSandbox": true },
    { "id": "antigravity-cli", "enabled": false, "installInSandbox": false },
    { "id": "opencode", "enabled": false, "installInSandbox": false }
  ]
}
```

Agent Client adapter 会声明镜像包、版本命令、状态目录、凭证/配置 mount、
setup hint、alias 以及有执行时限的生命周期 hook。`agent-infra` 等非客户端
工具和已配置的 custom tool 不受该选择影响。修改 `installInSandbox` 后，
需要重建镜像并重新创建受影响容器。运行时能力 label 会让 start、exec 和
recovery 拒绝 mount 或 hook 策略已与当前配置不一致的旧容器。

对 Claude Code 而言，将 `installInSandbox` 设为 `false` 就是受支持的卸载方式。重建并重新创建受影响沙箱后，工具、凭证 mount 与 hooks 会被收敛移除。宿主 `~/.claude` 数据、Keychain 凭证、插件、历史记录以及 `~/.agent-infra/credentials/<project>/claude-code` 会完整保留；重新设为 `true` 时可继续复用这些宿主资产。

Antigravity adapter 使用[官方安装器](https://antigravity.google/docs/cli/install)，
调用 `agy` 命令，并在[官方配置目录](https://antigravity.google/docs/cli/settings)
下预置 settings、keybindings 与 MCP 配置。新建容器后需在容器内运行一次
`agy` 完成认证。

OpenCode adapter 通过共享的 Node/npm 镜像层安装 `opencode-ai`，并把每个分支的
状态保存在 `/home/devuser/.local/share/opencode` 单一持久卷中。卷内的
`XDG_CONFIG_HOME` 为 `.local/share/opencode/.xdg/config`，`XDG_STATE_HOME`
为 `.local/share/opencode/.xdg/state`，常规数据根目录仍为
`/home/devuser/.local/share`。adapter 只读取和写入规范 XDG 配置；宿主配置只补齐缺失的字符串
`model` 与 `small_model`。唯一实时凭证 mount 是宿主
`XDG_DATA_HOME/opencode/auth.json`，version/help 的无认证 smoke 不要求该文件存在。

禁用或卸载 OpenCode 只会移除 adapter 管理的项目资产与选择状态，不会删除宿主
XDG 目录、分支运行时卷、用户自建 command 或其他非托管运行时数据；
重新启用 adapter 后会继续复用这些保留状态。

禁用客户端绝不会删除其宿主凭证、配置或历史。即使宿主仍保留已禁用客户端
的状态，`sandbox show` 也只展示当前选中的工具。只有显式执行
`sandbox rm`、`sandbox prune` 等清理命令时，才会考虑删除宿主状态。

adapter hook 按声明顺序串行执行，默认 deadline 为 30 秒，上限为 5 分钟。
创建阶段超时是 fatal，进入前刷新超时只产生 warning，恢复检查超时会把
容器判为 unhealthy。该 timeout 是内部安全边界，不是用户配置项。

## 运行时代理继承

`ai sandbox create <branch> --inherit-proxy` 会把宿主机上的标准代理变量复制进新容器环境。`-P` 是同一个布尔开关的短写法。默认仍然关闭：不传该开关时，agent-infra 不读取也不注入宿主代理变量。

固定白名单如下：

- `http_proxy` / `HTTP_PROXY`
- `https_proxy` / `HTTPS_PROXY`
- `all_proxy` / `ALL_PROXY`
- `no_proxy` / `NO_PROXY`

只有已存在且不是空字符串的变量会被复制。键和值都会原样传递：agent-infra 不解析代理 URL，不补齐缺失的大小写变体，不合并冲突，不解释 `NO_PROXY`，也不新增 WebSocket 专用变量。如果大小写变体同时存在，它们都会写入容器，最终由容器内客户端决定使用哪一个；建议在宿主机上保持这些值一致。

代理值通过与工具环境变量和 `GH_TOKEN` 相同的私有 Docker `--env-file` 路径写入，因此凭据不会出现在 Docker argv 或项目配置中。但创建后它们仍是容器环境变量，容器内所有进程都可以读取。不要把真实代理凭据写进 shell history 或提交到仓库；如果必须使用凭据，只在执行 create 命令时通过宿主环境提供。

无凭据示例：

```bash
HTTP_PROXY=http://proxy.internal:8080 \
HTTPS_PROXY=http://proxy.internal:8080 \
NO_PROXY=localhost,127.0.0.1 \
ai sandbox create feature/proxy --inherit-proxy
```

代理环境只在容器创建时捕获。`ai sandbox start` 和 `ai sandbox exec` 不会刷新这些变量。代理入口地址变化，或需要彻底移除沙箱里的代理变量时，需要删除并重新创建容器。如果入口地址保持稳定，PROXY / DIRECT 模式切换应在该地址背后的代理层完成；仅停止代理进程但保留容器代理变量通常会导致客户端连接失败。

本能力只覆盖容器运行时环境变量。Docker daemon 代理、镜像拉取、BuildKit 和镜像构建期代理传递属于独立的构建期问题，不由 `--inherit-proxy` 处理。

## 构建期代理继承

使用 `ai sandbox create <branch> --inherit-build-proxy` 或 `ai sandbox rebuild --inherit-build-proxy`（短写 `-B`），可在本次调用中把非空的大写 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 传给托管 Dockerfile 中需要联网的 build step。值只存在于 Docker 子进程环境，并通过临时 BuildKit secret mount 暴露给这些步骤；Docker argv 与镜像元数据只包含 secret 名称。该开关与运行时 `-P` 相互独立；自定义 Dockerfile 会被拒绝；最低要求为 Docker Engine >=20.10.0，且所有可见 BuildKit 节点均 >=0.9.0。

该开关不会配置 Docker daemon 或 builder。镜像拉取与 `FROM` 解析仍需在 native Docker、Docker Desktop、OrbStack、Colima 或 WSL2 Docker 集成中配置代理。不传 `-B` 时，镜像检查与构建行为保持不变。

`ai sandbox rebuild` 默认保留 Docker build cache，因此会快速重打沙箱镜像，不会刷新每个软件包。需要升级镜像时使用 `ai sandbox rebuild --refresh`：它会向 Docker 传入 `--no-cache --pull`，重新拉取当前 Ubuntu 基础镜像，并重跑 apt、tmux 编译和全局 npm 安装层。容器内 Claude Code 更新已关闭，OpenCode 启动时更新检查也已关闭；`--refresh` 是沙箱托管工具的常规升级入口。手动 `opencode upgrade` 不受该保护覆盖。Ubuntu 24.04 沙箱基础镜像提供的默认 `python3` 是 Python 3.12，因此硬编码 Python 3.10 路径的脚本可能需要调整。

`ai sandbox exec` 也会向容器透传一小组终端检测白名单变量（`TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`LC_TERMINAL`、`LC_TERMINAL_VERSION`）。这样可以让交互式 TUI 保持与宿主终端一致的行为，例如 Claude Code 的 `Shift+Enter` 换行支持，同时避免把整个宿主环境灌入容器。

`ai sandbox start`、`ai sandbox exec` 与使用沙箱的 `ai run` 现在会在执行用户工作前共享同一套 ready 检查。已停止的容器启动后，agent-infra 会修复 tmpfs owner/mode，重水合容器内仍有 staging mount 的全部 seed，重建内置 Codex prompts 链接，并验证 mount topology、shell aliases、Codex 可用性、状态目录可写性以及本次实际复制的条目。已在运行的容器只接受无损结构检查：只要现有 seed target 可写，即使内容、时间戳或 inode 与宿主 staging 副本不同也会原样保留。恢复不会重放 custom `postSetupCmds`，custom `versionCmd` 结果仍只是 advisory。

## 按任务隔离的工作区身份

每个沙箱都有显式 workspace identity。branch-only 沙箱对 `active`、`completed`、`blocked`、`archive` 使用互不重叠的只读目录挂载。task-bound 沙箱把 `active` 目录挂载替换为只读的 `.agents/workspace/active/.short-ids.json` 文件，继续只读挂载 `completed`、`blocked`、`archive`，并且只把 `.agents/workspace/active/<TASK-id>` 覆盖为可写。active 祖先目录由可写的 `/workspace` worktree 提供；宿主 workspace 根目录绝不会被挂载，其他状态下的全部任务都不可见。

如果 task-bound 容器仍然存在，但任务已经移动到 `completed`，`ai sandbox exec <branch>` 会在核对容器标签、唯一的 completed 任务、分支、task view 和历史任务挂载后，原位重新进入同一个容器。该流程内部使用完整 TASK-id，不会恢复或重新分配 active 短号。如果 completed readiness 失败，或用户执行 `ai sandbox exec --recreate <branch>`，命令会 fail closed，原容器保持不变。需要保留现场时可手动进入原容器；如果明确要新建 branch-only 沙箱，则分开执行 `ai sandbox rm <TASK-id>` 和 `ai sandbox create <branch>`。`ai sandbox rm` 是完整的交互式 sandbox 清理入口，不是只删除容器；它可能删除 worktree、本地分支、工具/shell 状态和 branch share。

两种 identity 都可以通过专用 typed `task-create` 控制请求创建新任务。沙箱 AI 只写一次版本化 candidate JSON；宿主负责严格验证、派生宿主字段、原子持久化、分配短号并尝试平台同步。该例外只授予“创建”能力：不会暴露宿主 workspace，不会让 branch-only 执行 lifecycle/orchestration，不会挂载新任务，也不会改变当前沙箱 identity。

创建重试包含两层身份：重复 outer request ID 即使在 broker 重启后也会被拒绝；超时后调用方使用新的 outer ID，但必须复用原不可变 candidate 文件和业务幂等 key。语义相同的 JSON 返回原任务 `no-op`，任一字段值变化均 fail closed。平台失败时保留本地任务和短号，并返回结构化 warning。

任务生命周期、完成收尾和编排统一使用一个 typed Task Control Authority，但入口承载分开。direct-host 命令通过本地 authority adapter 执行，不创建 broker、control channel、manifest 或沙箱 authority 根目录。沙箱 client 只负责创建 control request；只有 broker 启动的 executor 依次通过 gate、current manifest、request、owner、lease 和 controller 校验后，才能成为 authority caller。branch-only 容器、identity 不匹配、未知命令族和旧共享 workspace 容器都会 fail closed。`ai sandbox ls` 通过 `WORKSPACE` 与 `TASK` 列展示身份，`ai sandbox show` 展示同一份基于标签的事实。

v0.9.7 的父挂载加子挂载拓扑属于 legacy，与当前 per-state 拓扑有意不兼容。升级时，或回滚时旧代码访问较新的 per-state 容器，检查都会 fail closed；请执行一次 `ai sandbox start --recreate <task-ref-or-branch>`。容器内进程、tmux 会话、writable layer、普通 `/tmp` 和 RAM 状态可能丢失，但 worktree、本地分支以及宿主管理的任务/工具数据会保留。

控制 broker 会向容器发布只读健康状态，并在一个授权请求由独立、可追踪的进程组执行期间持续存活。请求携带每沙箱 generation 和两秒绝对受理截止时间；broker 发布 `healthy`、`busy` 或 `parked`，在 acceptance 前拒绝过期或 generation 不匹配的请求，并在恢复时先终止遗留进程树再接收新工作。调用方可以用新 request ID 重试 acceptance 前的 `BUSY` 或超时拒绝；一旦请求已被接受而最终结果未知，则不得自动重试。

控制时序集中在可注入的 policy 中：生产默认 control tick 为 250ms，慢速检查和容器 heartbeat 为 5s，parked 退避从 1s 增长到 5s，quiesce deadline 为 7s。测试可以注入更短的值，不需要改变安全状态机。canonical control manifest 只有一份 current、无 version 的 schema，包含精确 container identity、受控 labels 和 root-relative `runtimeDir`；request、response、status、lease、execution、broker owner 与 controller 记录继续保留各自独立的协议版本。materialize 阶段只创建 control 目录并保留内存 draft；完成 container identity 和 labels 检查后，finalize 才通过原子写入发布完整 manifest，随后才能启动 broker。缺失、带 version、字段不完整或未知的 manifest 会 fail closed，并给出 container-only recreation/rebuild 指引；不会按兼容格式解析或迁移。task-bound 容器会把 `runtimeDir` 以读写方式挂载到 `/run/agent-infra/runtime`，客户端状态位于 `runtime/clients/<client>/<store>`，direct-host 则使用仓库内 `.agents/workspace/.runtime/codex-*` fallback。替换失败或结果不确定时保留 control root 和证据。

显式 `ai sandbox rm` 和 `--purge` 使用 manifest 记录的精确容器 ID：先 quiesce broker 与 execution，等待软停止阶段，再删除精确容器，确认 exact-ID 得到权威 absent，重新核对 manifest、owner 与 generation，最后才使用剩余 deadline 做 force cleanup。精确 ID 的 not-found 不会被同名新容器混淆。inspect 未知、删除失败、owner 被替换或 deadline 耗尽时，会保留 control root 与证据，等待下一次受控重试。

依赖宿主环境的校验统一通过内部命令 `agent-infra-internal task-validate <branch | task-ref> [--scope snapshot|inplace] [--timeout <ms>] [--format text|json] -- <command>` 执行，由 `run-manual-validation` 技能机械调用。默认 `snapshot` 在任务分支 commit 对应的临时 detached worktree 中运行命令，并保证清理。`inplace` 获取宿主 lease、等待 broker 进入 parked、停止沙箱容器、对原 worktree 运行命令，随后恢复分支、容器、lease 与 broker 健康状态。ready 检查把 task view、runtime、control 作为三个独立信号；runtime 会执行无损的 write/read/delete 探针。新容器的 runtime mount settling 最多触发一次 restart/recheck，但 ready 路径不会轮换 generation，也不会清理旧 runtime evidence。`run-manual-validation` 技能只记录去敏的 `validation-run` 证据；`complete-manual-validation` 仍是独立的维护者确认步骤。

原地恢复失败时，命令会在进入容器或调度 tmux 前停止，不会自动替换容器。对于 active 和 branch-only 沙箱，只有显式传入 `--recreate` 才授权 container-only fallback：`ai sandbox start --recreate <target>`、`ai sandbox exec --recreate <target> [cmd...]` 或 `ai run --skill <skill> --task <task-ref> --recreate`。对于 `sandbox exec`，只有 target 之前的 flag 由宿主解析；target 之后的 `--recreate` 会透传给容器命令。completed task-bound 重入是例外：readiness 失败和 `ai sandbox exec --recreate <branch>` 都会被拒绝，不调用 replacement；错误会给出手动 `docker exec` 路径，以及用户明确要新建 branch-only 沙箱时分开执行的 `ai sandbox rm <TASK-id>`、`ai sandbox create <branch>` 命令。`ai sandbox rm` 是完整的交互式 sandbox 清理入口，不是只删除容器；它可能删除 worktree、本地分支、工具/shell 状态和 branch share。普通替换会保留 worktree、local branch、宿主管理的工具 seed、shell 配置与 `/share` 数据，但会丢弃旧 container ID、writable layer、普通 `/tmp`、进程、tmux session 与其他 RAM 状态；该路径绝不会执行完整的 `ai sandbox rm`。

tmpfs runtime 数据本来就是临时数据。tmpfs 丢失后，`/home/devuser/.codex` 下的 Codex 数据库、日志、session 与其他未列入 seed 的文件无法恢复；`config.toml`、`model-catalogs` 等声明式 seed 可以从只读 staging mount 重建；bind mount 的 worktree、凭据、shell 配置与 share 目录继续由宿主持久化。

`ai sandbox ls` 保持精简：只列出当前项目的 Containers 容器表（`#` 行号、`SHORT` 任务短号，以及名称、状态、workspace identity、完整 task ID 和分支），不再打印 worktree 列表和各工具的 state 路径。要查看某个沙箱的这些详情，使用 `ai sandbox show <branch | TASK-id | N>`：它会打印基于标签的 workspace identity、该分支的 worktree 路径和各工具（Claude Code、Codex、Antigravity CLI、OpenCode）的 state 路径。入参契约与 `ai sandbox exec`、`ai sandbox start` 一致，因此 `ai sandbox show 11` 会通过 `.agents/workspace/active/.short-ids.json` 解析当前任务短号。

下一个大版本的破坏性迁移：任务短号仅使用裸数字。请把 `#NN` 改为 `NN`；引用后的 `#NN` 输入也会被拒绝。

在 macOS 上，交互式 `ai sandbox exec <branch>` 会尽力桥接宿主图片粘贴。当你按下 `Ctrl+V` 且宿主剪贴板当前是图片时，agent-infra 会从宿主剪贴板读取图片，将 PNG 写到 `~/.agent-infra/clipboard/`，再以 bracketed paste 注入容器内路径，让 Claude Code、Codex、Antigravity CLI 和 OpenCode 按图片附件处理。宿主剪贴板只读，不会被改写。该能力会自动降级：已有沙箱需要重建后才有 `/clipboard` 挂载；如果可选 pty 依赖或剪贴板探测不可用，会回退到原本的交互进入方式。排查鼠标、滚动或其他输入异常时，可以设置 `AI_SANDBOX_NO_CLIPBOARD_BRIDGE=1` 跳过桥接，直接进入原本的交互路径。

当你通过 SSH 运行远端沙箱时，可先在手边这台 Mac 上执行 `ai cp <ssh-alias>`，把本机剪贴板 PNG 推送到远端 Mac 或无桌面 Linux 主机。典型流程是：Cmd+C 复制图片，运行 `ai cp mini`，回到已有 SSH session 后按 `Ctrl+V`。Darwin 继续写入 NSPasteboard；Linux 需要远端已安装兼容版本的 agent-infra，图片会写入 `~/.agent-infra/clipboard/`，再由沙箱的只读 `/clipboard` 挂载注入。命令使用基于 ssh key 的非交互 ssh/scp。

`ai sandbox exec` 和 `ai sandbox refresh` 会在宿主机凭证存储与 `~/.agent-infra/credentials/*` 下的所有沙箱项目副本之间做双向 reconcile。长时间运行的沙箱如果先刷新了 OAuth token，下一次进入或刷新命令会把最新有效副本回写到宿主 Keychain 或 `~/.claude/.credentials.json`；宿主机更新时也会继续覆盖项目副本。如果所有副本都已失效，`ai sandbox refresh` 会尝试 `claude /status` 探活，只有探活无法恢复时才提示重新登录。

启用 Claude Code 时，`ai sandbox create` 还会把宿主机 `~/.claude/settings.json` 中的模型和 API provider 设置合并到沙箱内的 Claude Code settings。已有的沙箱值优先，因此沙箱内的本地覆盖会被保留。凭证仍使用上面的专用 credentials 通道；provider 环境设置只会作为 Claude Code settings 值复制。

## 宿主-沙箱文件交换

`ai sandbox create` 会自动挂载两个可读写目录，方便宿主与容器之间互相 drop 文件，不污染 git 工作树：

- `/share/common` <- `~/.agent-infra/share/<project>/common/`：项目级共享，跨分支可见。
- `/share/branch` <- `~/.agent-infra/share/<project>/branches/<branch>/`：分支独占。
- `/clipboard` <- `~/.agent-infra/clipboard/`：macOS 图片粘贴桥接使用的只读存储。

这两条路径硬编码，不暴露 `.airc.json` 配置项。首次 `create` 时会自动创建宿主目录；执行 `ai sandbox rm <branch>` 删除时会附带询问是否清理（默认 yes）。`ai sandbox rm --unbound` 批量删除所有**未绑定 active 任务**的沙箱（即 `ai sandbox ls` 中短号为 `-` 的行）；可加 `--dry-run` 预览，或 `--yes` 跳过普通确认（非交互 shell 中必须显式传 `--yes`）。`ai sandbox rm --purge` 则拆除项目的**全部**沙箱（容器、worktree、镜像、VM）。**破坏性变更**：`--all` 已移除；旧调用会返回迁移错误，必须改用 `--unbound`。

所有删除路径都会在破坏性清理前检查全部目标 worktree。存在 staged、unstaged、冲突或非 ignored untracked 修改时，批量删除、purge、prune、`--yes` 和其他非交互删除都会 fail closed。只有交互式 `ai sandbox rm <branch>` 可以在展示精确 dirty snapshot 后，通过一次默认否定的独立确认放弃修改；删除前 snapshot 一旦变化，授权立即失效。
可先用 `ai sandbox prune --dry-run` 查看旧版本或异常中断遗留的孤儿 per-branch 状态目录，再用 `ai sandbox prune` 只删除没有活跃 sandbox 容器对应的目录。
已有沙箱可通过 `ai sandbox start --recreate <task-ref-or-branch>` 加载托管挂载点变更，包括已移除的挂载。readiness 会先识别过期的 mount plan，再授权 container-only replacement，并保留 worktree。

首次执行 `ai sandbox create` 时，agent-infra 会在
`~/.agent-infra/share/<project>/common/` 以及每个 `branches/<branch>/`
目录下写入一份中英双语 `README.md`，帮助你发现这些通道。README 是幂等的，
可以安全删除；scaffold 仅在文件缺失时写入。

## Broker–sandbox 控制协议

宿主 broker 与沙箱 client 通过 bind-mounted control root 中的 JSON 文件通信。
它不是 HTTP、TCP 或 Unix socket。broker 是唯一可以执行宿主 task 操作的进程；
executor 子进程只通过一次性的 IPC gate 获得调用机会，不会从沙箱获得 control
root 的写权限或宿主控制 authority。

### 传输目录结构

以下是维护时需要关注的记录（实际宿主路径由 manifest 记录，未必与容器内路径
相同）：

```text
control-root/
├── manifest.json
├── broker.json
├── channel/
│   ├── requests/<request-id>.json
│   └── responses/
│       ├── <request-id>.accepted.json
│       ├── <request-id>.payload.json   （可选输出 payload）
│       └── <request-id>.json
├── processing/<request-id>/
│   ├── request.json
│   ├── execution.json
│   ├── reservation.json
│   └── result.json
├── consumed/<request-id>
├── public/status.json
└── audit.ndjson
```

client 首先检查 `status.json` 中的 generation 和 broker heartbeat，然后把请求写入
私有临时文件，再 rename 为 `requests/<request-id>.json`。请求包含协议版本、请求
身份、沙箱 token、generation、绝对 admission deadline、control family 和该 family
的参数。broker 将请求 rename 到 `processing/<request-id>/request.json` 完成 claim，
创建 consumed marker，校验 manifest 绑定和 deadline，并在 `execution.json` 中记录
子进程身份。

accepted 是独立的持久 marker：`responses/<request-id>.accepted.json`。它只表示请求
已经被接纳，不是命令结果。terminal response 只发布一次到
`responses/<request-id>.json`，发布后不可覆盖。重复发布时会先 read-back 已有 terminal；
如果它与候选内容不同则 fail closed。client 可以在 client 或 broker 重启
后重复读取 terminal；但再次使用同一个 request ID 仍然属于 replay，不能再次执行
操作。

### result evidence 与完成顺序

executor 子进程退出后，由 broker 父进程先从 stdout/stderr 中去除 manifest token，
再计算 UTF-8 字节数和 SHA-256 摘要，先写入并严格 read-back 一个小型的
`processing/<request-id>/result.json`，然后才把内存中的 execution 标记为 settled：

```json
{
  "version": 1,
  "id": "<request-id>",
  "generation": "<generation>",
  "exitCode": 0,
  "stdoutBytes": 128,
  "stderrBytes": 0,
  "stdoutSha256": "<64 位小写十六进制字符>",
  "stderrSha256": "<64 位小写十六进制字符>",
  "captureState": "metadata-only"
}
```

这个记录只是 transport evidence，不是 task receipt，也不能替代 terminal response。
它刻意不包含 token、executor nonce、gate owner、PID、环境变量、宿主路径或原始输出。
`metadata-only` 表示重启后可以证明子进程已经退出并取得输出的元数据，但不能只凭
这个记录恢复完整输出正文。

提交顺序固定为：

```text
child close
  → result.json 原子发布并 read-back
  → 可选的已脱敏 payload 原子发布并 read-back
  → terminal response 发布并 read-back
  → 删除 processing evidence
```

如果 broker 在 result record 有效、terminal 清理前重启，普通 process-control family
可以收敛为带有“output unavailable”语义的 terminal response。task-finalization 更严格：
成功的 exit code 不能证明 task 已完成，canonical 宿主 finalization receipt 仍是业务
authority。如果 result evidence 缺失或格式错误，broker 会保持 uncertain/unknown，不能
创建新的 request ID，也不能重放 mutation。

每类记录的 authority 和生命周期刻意不同：

| 记录 | 写入者 | 生命周期 | authority |
| --- | --- | --- | --- |
| `request.json` | client，随后由 broker 通过 claim rename 接管 | claim 后清理 | 仅作为输入 |
| `execution.json` | broker | child prepared/running 期间 | 进程身份/恢复提示 |
| `reservation.json` | broker | admission 到 terminal cleanup | generation quota reservation |
| `result.json` | broker 父进程 | terminal commit 前 | 进程结果证据 |
| payload record | broker | generation 生命周期，仅在 terminal 引用时保留 | 已脱敏输出正文 |
| terminal response | broker | generation 生命周期 | transport 提交点 |
| finalization receipt | 宿主 finalization | task 生命周期 | 业务完成 authority |

client 永远不会把 `accepted`、`result.json` 或 payload candidate 当作成功，
只返回经过校验的 terminal response。这个分层可以避免 broker 重启时把不完整
的观测变成第二次宿主 mutation。

因此各个恢复断点是确定的：child 尚未产生有效 result 时保持 unknown；普通
family 有有效 result 时可以生成 output-unavailable terminal；finalization 仍
必须检查宿主 receipt；已经发布的 terminal 只能读取、不能覆盖。finalization receipt
缺失或绑定冲突时，不能落入 generic success terminal，processing evidence 和 reservation
会保留，等待后续同 ID 恢复。graceful shutdown 如果观察到已 settled 的 result，会先按同一
authority 尝试发布 terminal 再停止 broker；尚未 settled 的 child 则保留 accepted 和未知结果证据。

### 容量与保留（HD-3/A）

三个 profile 上限相互独立：

- `maxLogicalRecords = 1024`：一个 generation 中最多保留的 logical control record 数量。
- `maxResponseBytes = 64 MiB`：持久化 response/result/payload 数据和 reservation 的总预算，
  不是一条普通 stdout 字符串的大小。
- `maxTerminalRecordBytes = 1 MiB`：紧凑 terminal envelope 的上限，与可选输出 payload
  的存储空间分开计算。

result evidence 很小，由每个请求的 base reservation 覆盖；它不是第四个公开容量指标。字节计量使用磁盘上实际持久化的 UTF-8 bytes，包括 JSON 末尾换行。terminal
在 generation 生命周期内保留。processing/result evidence 是临时数据，只有 terminal
发布并验证后才能删除。恢复时，临时文件永远不能被当作权威记录。

broker 在写入 accepted marker 之前，会为本次请求的 accepted marker、紧凑 terminal 和
result evidence 预留固定的 base budget。reservation 自身占用一个 logical record，后续
payload 不能绕过这项预留。如果 generation 会超过 1024 个 logical record，或持久化的
terminal、payload 与 reservation 总量会超过 64 MiB，broker 会在 admission 阶段拒绝请求。base reservation
与已发布 payload 分开计量，不会把 reservation 和 payload 折叠成一个字节总数。
如果结果超过 1 MiB 的紧凑 envelope，且 generation 仍有余量，broker 可以把它写成单独的
已脱敏 payload；terminal 只保存 payload 的字节数和 SHA-256 引用，并设置
`outputState: "available"`。payload 无法保留时，terminal 仍会提交，但设置
`outputState: "unavailable"`。

logical record 只计数一次：同一请求的 terminal 或尚未完成的 reservation 占用一个 slot。
terminal 成功提交后，临时的 request、execution、result 和 reservation 会被删除；只有
terminal 及其引用的 payload 保留在 generation 内。没有被 terminal 引用的 payload 也会
在同一清理阶段删除。这样 quota 在 broker 重启后仍然可计算，并且 payload 不会独立成为
任务 mutation 的 authority。

维护排障时只读取所需的元数据。不要把 request token、execution nonce、PID、环境值、宿主
路径或原始 terminal 输出复制到 Issue、审计附件或普通日志中。client 在 accepted 后超时，
应使用同一个 request ID 执行 control recovery；不可为不可逆的 finalization 提交新请求。

当前协议使用 request version 3 和 response version 2。旧 response layout 不做 adapter、
双写或长期迁移；invalid 或 generation 混用必须 fail closed，并根据当前 manifest 重建
沙箱。payload 只能通过同一 request ID 和 generation 的 terminal 引用定位；它不能从
`result.json` 推断出来，也不能授权任何 task mutation。

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

> **不要往 `~/.agent-infra/dotfiles/` 放任何凭证。** 容器内是只读挂载，但整棵偏好树会链入所有项目沙箱。不要放 `.ssh/`、`.aws/credentials`、`.netrc`、`.gnupg/`、包含 `_authToken` 的 `.npmrc`、任何 AI 工具 OAuth/access token 文件，也不要放 `.gitconfig`。请使用专用凭证通道；GitHub 访问走 `gh` / HTTPS token 路径。本地 Git 偏好建议用 `.gitconfig.local` 配合 `[include]`。

**受保护路径**即使出现在 `~/.agent-infra/dotfiles/` 下，也会被钩子忽略：

| 路径模式 | 原因 |
|---|---|
| `.ssh/*` | host SSH 材料受保护，不会通过默认沙箱导入。 |
| `.gnupg/*` | GPG 私钥由 `gpg-agent` 管理。 |
| `.claude/*`, `.codex/*`, `.gemini/*` | AI 工具凭证使用专用 bind mount。 |
| `.config/opencode/*`, `.local/share/opencode/*` | OpenCode 宿主数据不走 dotfiles；只有 `auth.json` 使用独立实时 mount。 |
| `.host-shell-config/*` | agent-infra 管理的 shell 和 Git 配置。 |
| `.gitconfig`, `.gitignore_global`, `.stCommitMsg`, `.bash_aliases` | agent-infra 将这些路径软链到 `.host-shell-config/`，包含 `safe.directory` 和 GPG 同步状态。 |
| `README.md` | agent-infra 会在 dotfiles 根目录 scaffold 一份发现性 README；link hook 会忽略它，避免遮蔽 `$HOME/README.md`。 |

其他已经存在的真实目录（如 `~/.config/`、`~/.cache/`）不会被顶层 dotfile 替换。如果某个文件与这类目录冲突，钩子会打印警告并跳过：

```text
sandbox-dotfiles-link: skipping /home/devuser/.config (existing directory; use nested path like .config/<file> instead)
```

正确用法是嵌套路径，例如 `~/.agent-infra/dotfiles/.config/lazygit/config.yml`，不要把 `.config` 当成顶层文件。
