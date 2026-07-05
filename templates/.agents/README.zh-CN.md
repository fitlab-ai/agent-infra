# 多 AI 协作指南

本项目支持多个 AI 编程助手协同工作，包括 Claude Code、OpenAI Codex CLI、Gemini CLI、OpenCode 等。

## 双配置架构

不同的 AI 工具从不同位置读取配置：

| AI 工具 | 主要配置 | 备选配置 |
|---------|---------|---------|
| Claude Code | `.claude/`（CLAUDE.md、commands/、settings.json） | - |
| OpenAI Codex CLI | `AGENTS.md` | - |
| Gemini CLI | `AGENTS.md` | - |
| OpenCode | `AGENTS.md` | - |
| 其他 AI 工具 | `AGENTS.md` | 项目 README |

- **Claude Code** 使用专属的 `.claude/` 目录存放项目指令、斜杠命令和设置。
- **所有其他 AI 工具** 共享项目根目录下的统一 `AGENTS.md` 文件作为指令来源。

这种双配置方式确保每个 AI 工具都能获得适当的项目上下文，而无需重复维护。

## 目录结构

```
.agents/                        # AI 协作配置（版本控制）
  README.md                     # 协作指南
  QUICKSTART.md                 # 快速入门指南
  templates/                    # 任务和文档模板
    task.md                     # 任务模板
    handoff.md                  # AI 间交接模板
    review-report.md            # 代码审查报告模板
  workflows/                    # 工作流定义
    feature-development.yaml    # 功能开发工作流
    bug-fix.yaml                # 缺陷修复工作流
    code-review.yaml            # 代码审查工作流
    refactoring.yaml            # 重构工作流
  rules/                        # 协作规则索引（见 rules/README.md）
  workspace/                    # 运行时工作区（已被 git ignore）
    active/                     # 当前活跃任务
    blocked/                    # 被阻塞的任务
    completed/                  # 已完成的任务
    logs/                       # 协作日志

.claude/                        # Claude Code 专属配置
  CLAUDE.md                     # Claude 项目指令
  commands/                     # 斜杠命令
  settings.json                 # Claude 设置
```

## 协作模型

多 AI 协作遵循结构化工作流：

1. 分析
2. 设计
3. 实现
4. 审查
5. 修复问题
6. 提交

### 阶段详情

1. **分析** - 理解问题，探索代码库，识别受影响的区域。
2. **设计** - 创建技术方案，定义接口，概述实现思路。
3. **实现** - 按照设计方案编写代码。
4. **审查** - 审查实现的正确性、代码风格和最佳实践。
5. **修复问题** - 处理审查阶段的反馈意见。
6. **提交** - 最终确认变更，编写提交信息，创建 PR。

### 任务交接

当一个 AI 完成某个阶段后，会生成一份**交接文档**（参见 `.agents/templates/handoff.md`），为下一个 AI 提供上下文。这确保了不同工具之间的工作连续性。

## AI 工具能力对比

每个 AI 工具有不同的优势，请据此分配任务：

| 能力 | Claude Code | Codex CLI | Gemini CLI | OpenCode |
|-----|-------------|-----------|------------|----------|
| 代码库分析 | 优秀 | 良好 | 优秀 | 良好 |
| 代码审查 | 优秀 | 良好 | 良好 | 良好 |
| 代码实现 | 良好 | 优秀 | 良好 | 优秀 |
| 大上下文处理 | 良好 | 一般 | 优秀 | 一般 |
| 重构 | 良好 | 良好 | 良好 | 良好 |
| 文档编写 | 优秀 | 良好 | 良好 | 良好 |

### 推荐分配

- **分析和审查** - Claude Code（推理能力强，探索全面）
- **代码实现** - Codex CLI 或 OpenCode（代码生成快，命令式工作流顺手）
- **大上下文任务** - Gemini CLI（大上下文窗口，适合跨文件分析）
- **命令式迭代** - OpenCode（适合按工作流连续推进）

## 快速入门

1. **阅读快速入门指南**：参见 `QUICKSTART.md` 获取分步说明。
2. **创建任务**：将 `.agents/templates/task.md` 复制到 `.agents/workspace/active/`。
3. **分配给 AI**：更新任务元数据中的 `assigned_to` 字段。
4. **执行工作流**：按照 `.agents/workflows/` 中相应的工作流执行。
5. **交接**：切换 AI 时，从模板创建交接文档。

## Label 规范

本项目的协作 labels 按以下前缀分类，各前缀有明确的适用范围：

| Label 前缀 | Issue | PR | 说明 |
|---|---|---|---|
| `type:` | — | Yes | Issue 优先使用平台原生的类型/分类字段；PR 无原生类型字段时，通过 `type:` label 驱动 changelog 和分类 |
| `status:` | Yes | — | PR 有自身状态流转（Open / Draft / Merged / Closed）；Issue 使用 `status:` label 标记等待反馈、已确认等项目管理状态 |
| `in:` | Yes | Yes | Issue 和 PR 均可按模块筛选 |

使用 `/init-labels` 命令可通过平台适配器一次性创建标准 labels。

## 私有平台扩展

如需将 agent-infra 接入私有代码托管平台：

1. 在 `.agents/.airc.json` 中把 `platform.type` 设为稳定标识，例如 `my-platform`。
2. 以 `.agents/rules/` 下已生成的规则文件为起点，改写为你的平台 CLI 或 API 调用，同时保持运行时文件名不变。
3. 将这些自定义规则文件加入 `.agents/.airc.json` 的 `files.ejected`，避免后续执行 `agent-infra update` 时被覆盖。
4. 如果你维护的是模板源码分支或私有 fork，需要先补齐对应的 `.{platform}.` 模板变体，再把该平台标识加入模板同步逻辑。
5. 在正式推广前，先用一个测试任务完整验证工作流和 gate 校验。

## 外部模板与 Skill 源

团队可以在 `.agents/.airc.json` 中配置外部模板源和共享 skill 源，用于接入私有平台模板、私有规则和团队维护的自定义 skill：

```json
{
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  }
}
```

模板源优先级为内置模板优先，外部模板只做补充；多个外部模板源之间，后面的 source 覆盖前面的 source。同步报告会在 `templateSources.conflicts` 中列出被忽略的同名文件。外部模板和 skill 可能包含会被 AI 工作流执行的脚本，只配置可信路径。

## 自定义 Skills

项目可以在内置任务工作流之外增加自己的 skill。

### 项目内本地 skill

在 `.agents/skills/<name>/` 下创建目录，并添加 `SKILL.md`：

```text
.agents/skills/
  enforce-style/
    SKILL.md
    reference/
      style-guide.md
```

推荐 frontmatter：

```yaml
---
name: enforce-style
description: "在代码审查前应用团队风格规范。当需要在评审前统一团队代码风格时使用"
args: "<task-id>"   # 可选
---
```

`description` 采用「一句话职责 + 场景触发子句」写法：在简短职责描述后补充「当……时使用」（英文 `SKILL.en.md` 用「Use when …」），作为跨 TUI 的触发语义，供支持 Agent Skills 的工具在自然对话中自发现该 skill。**不要**为此新增 `triggers` 等额外 frontmatter 字段。

新增或修改自定义 skill 后，再执行一次 `update-agent-infra`。同步过程会自动检测非内置 skill，并为 Claude Code、Gemini CLI、OpenCode 生成对应命令。

### 共享 skill 源

如需复用团队集中维护的 skill，可在 `.agents/.airc.json` 中配置：

```json
{
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  }
}
```

每个 source 都应镜像 `.agents/skills/` 的目录结构，并在每个 skill 目录根部提供 `SKILL.md`。

### 同步行为

- `.agents/skills/` 中手动创建的项目自定义 skill 不会被 managed 文件清理删除
- 多个 source 按声明顺序应用；后面的自定义 source 会覆盖前面的自定义 source 文件
- 对于仍存在于配置 source 中的 skill，如果源里删掉文件，下次同步时会删除本地对应残留文件
- 自定义 source 不能覆盖内置 skill；如果与内置 skill 同名，会跳过该 source skill
- 如果项目必须接管某个内置 skill 或命令，请使用 `files.ejected`

## 文件归属与同步策略

`.agents/.airc.json` 的 `files` 字段把项目文件分为三类：

| 类别 | 模板中存在时 | 模板中不存在时 | 清理行为 |
|------|--------------|----------------|----------|
| `managed` | 从模板写入并覆盖 | 视为模板已下线 | 删除项目本地副本 |
| `merged` | 由 AI 或人工语义合并 | 不从模板写入 | 保留项目本地副本 |
| `ejected` | 首次可从模板创建，已存在时跳过覆盖 | 不从模板写入 | 保留项目本地副本 |

`ejected` 有两种常见用法：

1. **接管内置文件**：项目需要完全控制原本来自模板的规则、命令或配置文件，避免后续同步覆盖本地内容。
2. **声明项目独占文件**：项目自己的文件落在 managed 目录通配下，但模板中没有同名文件；把它列入 `files.ejected`，避免同步时被当作模板已下线文件删除。

`ejected` 条目支持字面路径或 glob，匹配规则与 `merged` 相同。

## 内建 TUI 选择

`.agents/.airc.json` 顶层 `tuis` 数组用于决定 agent-infra 应当为哪些内建 TUI（`claude-code`、`codex`、`gemini-cli`、`opencode`）安装并维护命令文件。

| 取值 | 含义 |
|------|------|
| `tuis` 缺失或为 `null` | 启用全部四个内建 TUI（向后兼容默认，适用于本字段引入之前的 `.airc.json`） |
| `tuis: []` | 不维护任何内建 TUI。适用于只依赖 `customTUIs`、不需要安装任何内建命令文件的项目 |
| `tuis: [<子集>]` | 仅维护列出的 TUI；未知 id 会被忽略 |

`ai init` 会通过交互式多选询问该字段：

- 直接回车 = 接受默认值（全部内建 TUI 启用）。
- 输入逗号分隔的编号或 id（如 `1,3` 或 `claude-code,opencode`）= 只保留子集。
- 输入 `none` = 明确不启用任何内建 TUI（通常配合后续在 `customTUIs` 添加条目使用）。
- 非法输入（重复、超界、未知 id、纯空白）会让 init 以非零退出码终止。

### 取消某个 TUI 的副作用

通过 `ai init` 或手工编辑 `.airc.json` 取消某个内建 TUI 后，下一次 `ai update` / `update-agent-infra` 会：

- 跳过该 TUI 的 seed 命令文件写入（例如 `.gemini/commands/<project>/update-agent-infra.toml`）；
- 在回填 `files.managed` / `files.merged` 时跳过该 TUI owned 的默认条目；
- **物理清理**该 TUI owned 路径前缀（`.claude/`、`.codex/`、`.gemini/`、`.opencode/`）下的已有文件——清理列表会出现在 `report.managed.removed`，与切换 `platform` 时的清理行为一致。

若希望保留某个具体文件，把它加入 `files.ejected`：被 ejected 的、属于已取消 TUI 的条目会保持原状，sync 不会重新创建也不会删除。

### 与其他配置字段的关系

- `tuis` 控制 **agent-infra 写入与维护哪些 TUI 的命令文件**，与 `sandbox.tools`（控制**沙箱镜像里安装哪些 CLI**）相互独立。两者互不影响；`sandbox.tools` 的说明见 Sandbox 一节。
- `tuis` 与 `customTUIs`（见下）相互独立。取消某个内建 TUI 时 customTUI 命令文件不会被清理，即便 customTUI 的 `dir` 落在该 TUI 的 owned 前缀下（例如 `dir: ".codex/commands"` 的 customTUI 在 `codex` 被取消时仍会保留）。

## 自定义 TUI 配置

当团队使用的 AI TUI 不属于内置命令目标时，可以在 `.agents/.airc.json` 顶层配置 `customTUIs` 数组。该配置用于让 agent-infra 输出正确的下一步命令，并通过学习自定义 TUI 目录中的既有命令文件，为项目自定义 skill 生成同格式命令。

| 字段 | 必填 | 含义 |
|------|------|------|
| `name` | 是 | 报告和下一步提示中展示的工具名称，例如 `<your-tui-name>`。 |
| `dir` | 是 | 相对项目根目录的命令目录，例如 `.<your-tui>/commands`。路径必须位于项目根目录内。 |
| `invoke` | 是 | 面向用户展示的命令模板，用于生成下一步提示。 |

`invoke` 支持的占位符：

| 占位符 | 替换为 | 示例 |
|--------|--------|------|
| `${skillName}` | skill 命令名，例如 `review-code` 或 `commit`。 | `<your-cli> ${skillName}` -> `<your-cli> review-code` |
| `${projectName}` | `.airc.json` 中的 `project` 值，适用于带命名空间的命令。 | `/${projectName}:${skillName}` -> `/your-project:review-code` |

不带命名空间的自定义 TUI：

```json
{
  "customTUIs": [
    {
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "<your-cli> ${skillName}"
    }
  ]
}
```

带命名空间的自定义 TUI：

```json
{
  "project": "your-project",
  "customTUIs": [
    {
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "/${projectName}:${skillName}"
    }
  ]
}
```

`customTUIs` 每个条目对应一个自定义 TUI。若希望 `update-agent-infra` 为自定义 skill 生成命令文件，请在 `dir` 中保留至少一个引用内置 skill 路径的既有命令文件，例如 `.agents/skills/analyze-task/SKILL.md`；agent-infra 会以该文件作为格式参考。

## 沙箱自定义工具（Sandbox Custom Tools）

`customTUIs` 只负责生成 slash-command 文件，**不影响沙箱镜像**。如果要把一个非 npm 分发的 CLI 或工具（pip / cargo / curl 脚本 / 裸二进制）装进沙箱镜像、并 live-mount 它的凭证目录，需要在 `.agents/.airc.json` 的 `sandbox.customTools` 中声明。内建 sandbox 工具（`claude-code` / `codex` / `opencode` / `gemini-cli` / `agent-infra`）行为保持不变；其中 `agent-infra` 只提供沙箱内 `ai` / `agent-infra` CLI，不属于 `tuis` 或 `customTUIs` 配置。

### 必填字段

| 字段 | 含义 |
|------|------|
| `id` | 小写 id，匹配 `^[a-z0-9][a-z0-9-]*$`；由 `sandbox.tools` 引用；不可与内建 id 冲突。 |
| `install` | 安装描述符。`{ "type": "npm", "cmd": "<npm 包规范>" }` 执行 `npm install -g <cmd>`；`{ "type": "shell", "cmd": "<shell>" }` 在镜像构建阶段以 `devuser` 执行 shell。`cmd` 必须非空。 |

最小入口——把一个工具装进镜像所需的契约只有这两个字段：

```json
{
  "sandbox": {
    "tools": ["my-shell-tool"],
    "customTools": [
      {
        "id": "my-shell-tool",
        "install": { "type": "shell", "cmd": "curl -fsSL https://example.com/install.sh | bash" }
      }
    ]
  }
}
```

### 可选集成字段

只在你的工具真正需要时才加。**省略**则 loader 用合理默认值；**显式提供**则用你给的值；**显式给空串**会被拒绝（防止安装验证被绕过）。

| 字段 | 省略时的默认值 | 什么时候应该提供 |
|------|---------------|----------------|
| `name` | `id` | 想在沙箱报告 / 提示里显示更友好的名称。 |
| `containerMount` | `/home/devuser/.<id>` | 工具的配置 / 状态目录不在 `~/.<id>` 而在别处。必须是绝对路径。 |
| `versionCmd` | `which <id>` | 安装后的可执行文件名与 `id` 不同（例如 id 是 `anthropic-claude`，二进制名是 `claude`）；填 `"claude --version"` 让 sandbox-create 能验证安装。 |
| `setupHint` | `Run \`<id>\` inside the container to set up.` | setup 流程不一目了然，值得用一行说明。 |
| `envVars` | （无） | 工具通过环境变量找配置（如 `XDG_CONFIG_HOME` 风格或自定义 `*_CONFIG` 变量）。形状：`Record<string, string>`。 |
| `hostPreSeedFiles` / `hostPreSeedDirs` | （无） | 首次启动时从宿主复制文件 / 目录到工具沙箱配置目录。 |
| `pathRewriteFiles` | （无） | seed 进来的文件里有宿主绝对路径，需要改写为容器路径。 |
| `hostLiveMounts` | （无） | 把宿主凭证（如 OAuth token）实时挂进容器，读写共享。 |
| `postSetupCmds` | （无） | 首次安装完成后在容器内执行命令（如建符号链接）。 |

> **`sandboxBase` 不由用户配置。** loader 永远使用 `~/.agent-infra/sandboxes/<id>`，这样 `ai sandbox rm` / `prune` 才能找到工具状态目录。`customTools` 条目里写的任何 `sandboxBase` 都会被静默忽略。

实际场景示例——`anthropic-claude` 作为用户自定义 id，二进制名是 `claude`，并把宿主凭证 live-mount 进来：

```json
{
  "sandbox": {
    "tools": ["claude-code", "anthropic-claude"],
    "customTools": [
      {
        "id": "anthropic-claude",
        "install": { "type": "npm", "cmd": "@anthropic-ai/claude-code@stable" },
        "versionCmd": "claude --version",
        "hostLiveMounts": [
          { "hostPath": "~/.claude/.credentials.json", "containerSubpath": ".credentials.json" }
        ]
      }
    ]
  }
}
```

### 信任边界与执行身份

- `install.cmd` 在 `docker build` 阶段以 `devuser`（非 root）身份执行，只能写容器内文件系统，不能逃逸到宿主。信任模型与现有 `sandbox.dockerfile` 一致：你是 `.airc.json` 的作者，本次构建做什么由你负责。
- 因为不是 root，shell 安装无法 `sudo` / `apt-get`。非 npm 分发的几条可用路径：
  - 用户态安装器，落到 `~/.local/bin`、`~/.cargo/bin`、`~/.npm-global/bin`（如 `pipx`、`cargo install`、`curl … | bash` 配合 `INSTALL_DIR=$HOME/.local/bin`）。
  - 确实需要 root / 系统包时，仍走原有 `sandbox.dockerfile` 字段，接管整个 Dockerfile。
- 修改 `install.cmd` 或任何参与镜像签名的字段，下次 `ai sandbox` 命令会触发一次镜像重建。

### 与 `sandbox.dockerfile` 的交互

当 `sandbox.dockerfile` 指向自定义 Dockerfile 时，agent-infra 仍会把 `AI_TOOL_PACKAGES`（空格分隔的 npm 包规范）和 `AI_TOOLS_SHELL_INSTALL_B64`（base64 编码的 shell 安装脚本）作为 `--build-arg` 传入。你的自定义 Dockerfile 若未声明对应 `ARG`，shell 安装路径会被 docker build 静默忽略——这是接管 Dockerfile 后的应有代价。

## Skill 编写规范

编写或维护 `.agents/skills/*/SKILL.md` 及其模板时，步骤编号遵循以下规则：

1. 顶级步骤使用连续整数：`1.`、`2.`、`3.`。
2. 只有父步骤下的从属动作才使用子步骤：`1.1`、`1.2`、`2.1`。
3. 同一步中的从属选项、条件分支或并列可能性使用 `a`、`b`、`c` 标记；仅用于步骤内部的子项展开，不用于命名独立的决策路径或输出模板。
4. 不要使用 `1.5`、`2.5` 这类中间编号；如新增独立步骤，应整体顺延后续编号。
5. 调整编号时，必须同步更新文中的步骤引用，确保说明、命令和检查点一致。
6. 长 bash 脚本应从 SKILL.md 提取到同级 `scripts/` 目录中，SKILL.md 只保留单行调用（如 `bash .agents/skills/<skill>/scripts/<script>.sh`）和对脚本职责的概要说明。
7. 在 SKILL.md 及其 `reference/` 模板中，如需为独立的条件分流、决策路径或输出模板命名，统一使用“场景”命名（例如使用“场景 A”）。

### SKILL.md 体积控制

- SKILL.md 正文尽可能精简，把详细规则、长模板和大段脚本拆分到同级 `reference/` 或 `scripts/` 目录。
- 声明式配置统一放在同级 `config/` 目录，例如 `config/verify.json`。
  当 `required_sections` 或 `required_patterns` 包含语言相关文案时，提供 `config/verify.en.json` 和 `config/verify.zh-CN.json`；sync 会把选中的语言变体剥离为 `config/verify.json`。
- 骨架中使用明确导航，例如：`执行此步骤前，先读取 reference/xxx.md。`
- 长脚本继续放在 `scripts/` 目录，优先执行脚本而不是内联大段 bash。

## 完成校验

对会产生结构化产物或任务状态变更的 skill，统一在结束前运行完成校验：

```bash
node .agents/scripts/validate-artifact.js gate <skill-name> <task-dir> [artifact-file] [--format json|text]
```

- 每个 skill 在自己的 `config/verify.json` 中声明需要检查的事项
- 对语言相关的产物标题或锚点，`config/verify.en.json` 和 `config/verify.zh-CN.json` 之间只应让 `required_sections` 与语言相关的 `required_patterns` 不同
- 如果 skill 还会展示“下一步”提示，必须先通过完成校验，再输出这些指引
- 面向用户展示最终校验结果时，优先使用 `--format text` 输出可读摘要，而不是原始 JSON
- 共享逻辑集中在 `.agents/scripts/validate-artifact.js`，不要把详细校验规则重新塞回 SKILL.md
- 在回复中保留当次校验输出作为当次验证输出；没有当次校验输出，不得声明完成

## 常见问题

### Q：我需要单独配置每个 AI 工具吗？

不需要。Claude Code 从 `.claude/CLAUDE.md` 读取配置，其他所有工具从 `AGENTS.md` 读取。你只需维护两个配置源。

### Q：任务如何在 AI 工具之间传递？

通过存储在 `.agents/workspace/` 中的交接文档。每份交接文档包含上下文、进度和后续步骤，让接收方 AI 能无缝接续。

### Q：如果某个 AI 工具不支持 AGENTS.md 怎么办？

你可以将相关指令复制到该工具的原生配置格式中，或直接粘贴到提示词中。

### Q：多个 AI 可以同时处理同一个任务吗？

不建议。工作流模型是顺序的——每个阶段一个 AI。并行工作应在不同的任务或不同的分支上进行。

### Q：运行时文件存储在哪里？

在 `.agents/workspace/` 中，该目录已被 git ignore。只有 `.agents/` 中的模板和工作流定义受版本控制。
