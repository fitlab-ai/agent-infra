<p align="center">
  <img src="./assets/logo.svg" alt="Agent Infra 标志" width="200">
</p>

<h1 align="center">Agent Infra</h1>

<p align="center">
  AI 编程代理的协作基础设施 —— 为 Claude Code、Codex、Gemini CLI、OpenCode 提供 skills、工作流和沙箱。
</p>

<p align="center">
  <strong>从 Issue 到合并 PR，只需 9 条命令。</strong> 定义需求，让 AI 完成分析、方案设计、编码、审查和交付 —— 你只需在关键节点介入。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/v/@fitlab-ai/agent-infra" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/dm/@fitlab-ai/agent-infra" alt="npm downloads"></a>
  <a href="License.txt"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?logo=node.js" alt="Node.js >= 18"></a>
  <a href="https://github.com/fitlab-ai/agent-infra/releases"><img src="https://img.shields.io/github/v/release/fitlab-ai/agent-infra" alt="GitHub release"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

[English](README.md)

<a id="why-agent-infra"></a>

## 为什么需要 agent-infra？

越来越多的团队会在同一个仓库里混用 Claude Code、Codex、Gemini CLI、OpenCode 等 AI TUI，但每个工具往往都会带来自己的命令体系、提示词习惯和本地约定。缺少共享层时，结果通常是工作流割裂、初始化重复、任务历史难以追踪。

agent-infra 的目标就是把这层共享基础设施标准化。它为所有支持的 AI TUI 提供统一的任务生命周期、统一的 skill 词汇、统一的项目治理文件、隔离的开发沙箱以及统一的升级路径，让团队切换工具时不必重新发明流程。

<a id="see-it-in-action"></a>

## 实战演示

### 安装与初始化

<p align="center">
  <img src="./assets/demo-init.gif" alt="CLI 安装初始化演示" width="100%" style="max-width: 720px;">
</p>

完成初始化后，在你的 AI TUI 中打开项目并安装最新 skills：

```bash
/update-agent-infra
```

> AI 读取 `.agents/.airc.json`，自动定位已安装的模板根目录，并通过 `sync-templates.js` 确定性地同步最新的 skill 清单、managed 文件和注册表。

**场景**：Issue #42 报告 *"登录接口在邮箱包含加号时返回 500"*。以下是完整的修复流程 —— AI 执行主要工作，你掌控方向：

```bash
/import-issue 42
```

> AI 读取 Issue，创建 `TASK-20260319-100000`，提取需求。

```bash
/analyze-task TASK-20260319-100000
```

> AI 扫描代码库，定位 `src/auth/login.ts` 为根因，输出 `analysis.md`。

```bash
/plan-task TASK-20260319-100000
```

> AI 提出修复方案：*"在 `LoginService.validate()` 中清洗邮箱输入，并添加专项单元测试。"*
>
> **你审查方案后用自然语言回复：**

```
方案方向没问题，但不要动数据库结构。
只在应用层的 LoginService 里修复就行。
```

> AI 按你的要求更新方案并确认。

```bash
/implement-task TASK-20260319-100000
```

> AI 编写修复代码，添加 `user+tag@example.com` 的测试用例，运行全部测试 —— 通过。

```bash
/review-task TASK-20260319-100000
```

> AI 审查自己的实现：*"通过。0 阻塞项，0 主要问题，1 次要问题（缺少 JSDoc）。"*

```bash
/refine-task TASK-20260319-100000
```

> AI 修复次要问题并重新验证。

```bash
/commit
/create-pr TASK-20260319-100000
/complete-task TASK-20260319-100000
```

> 提交完成，PR #43 已创建（自动关联 Issue #42），任务归档。

**9 条命令，1 次自然语言纠正，从 Issue 到合并 PR。** 这就是完整的 SOP —— 编程也可以有标准作业流程。

以上每条命令在 Claude Code、Codex、Gemini CLI、OpenCode 中完全通用。任务进行到一半切换工具，工作流状态照常延续。

### 每个 skill 背后做了什么

这些不是简单的命令别名。每个 skill 都封装了手动操作时容易遗漏或不一致的标准化流程：

- **结构化产物** — 每个步骤都输出模板化的文档（`analysis.md`、`plan.md`、`review.md`），格式统一，而非自由发挥的散文
- **多轮版本化** — 需求变了？再执行一次 `analyze-task` 会生成 `analysis-r2.md`，完整修订历史自动保留
- **分级审查机制** — `review-task` 按 Blocker / Major / Minor 分类问题，附带文件路径和修复建议，而非含糊的"看着没问题"
- **跨工具状态延续** — `task.md` 记录了谁在什么时间做了什么；Claude 分析、Codex 实现、Gemini 审查——上下文无缝衔接
- **审计轨迹与联合署名** — 每个步骤自动追加 Activity Log；最终提交包含所有参与 AI 的 `Co-Authored-By` 署名

<a id="key-features"></a>

## 核心特性

- **多 AI 协作**：为 Claude Code、Codex、Gemini CLI、OpenCode 提供统一的协作模型
- **引导 CLI + skill 驱动执行**：初始化一次，后续日常操作交给 AI skills
- **双语文档**：英文为主文档，配套同步的中文版本
- **模板源架构**：`templates/` 目录镜像最终渲染出的项目结构
- **AI 辅助升级**：模板升级时可合并变更，同时尽量保留项目侧定制

<a id="quick-start"></a>

## 快速开始

### 1. 安装 agent-infra

**方式 A - npm（推荐）**

```bash
npm install -g @fitlab-ai/agent-infra
```

**方式 B - Shell 脚本**

```bash
# 便捷封装：检测 Node.js 后，内部执行 npm install -g
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh
```

**方式 C - Homebrew (macOS)**

```bash
brew install fitlab-ai/tap/agent-infra
```

### 更新 agent-infra

```bash
npm update -g @fitlab-ai/agent-infra
# 或者通过 Homebrew 安装时：
brew upgrade agent-infra
```

查看当前版本：

```bash
ai version
# 或：agent-infra version
```

### 2. 初始化新项目

```bash
cd my-project
ai init
# 或：agent-infra init
```

CLI 会收集项目元数据，向所有支持的 AI TUI 安装 `update-agent-infra` 种子命令，并生成 `.agents/.airc.json`。

> `ai` 是 `agent-infra` 的简写命令，两者等价。

### 3. 渲染完整基础设施

在任意 AI TUI 中执行 `update-agent-infra`：

| TUI | 命令 |
|-----|------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Gemini CLI | `/{{project}}:update-agent-infra` |
| OpenCode | `/update-agent-infra` |

该命令会检测当前打包模板版本并渲染所有受管理文件。首次安装和后续升级都使用同一条命令。

### 沙箱 aliases 与 GitHub CLI

`ai sandbox create` 在首次运行时会自动生成宿主机侧的 `~/.agent-infra/aliases/sandbox.sh`。该文件内置了 Claude、Codex、Gemini CLI 和 OpenCode 的 yolo 快捷命令模板，你可以直接修改；每次创建沙箱时，这个文件都会同步到容器内的 `/home/devuser/.bash_aliases`。

沙箱镜像也会预装 `gh`。如果宿主机上的 `gh auth token` 能成功返回 token，`ai sandbox create` 会把它以 `GH_TOKEN` 环境变量注入容器，让你在沙箱里直接使用 `gh`，无需额外登录配置。

`ai sandbox exec` 也会向容器透传一小组终端检测白名单变量（`TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`LC_TERMINAL`、`LC_TERMINAL_VERSION`）。这样可以让交互式 TUI 保持与宿主终端一致的行为，例如 Claude Code 的 `Shift+Enter` 换行支持，同时避免把整个宿主环境灌入容器。

<a id="architecture-overview"></a>

## 架构概览

agent-infra 的结构刻意保持简单：引导 CLI 负责生成种子配置，之后由 AI skills 和 workflows 接管后续协作。

### 端到端流程

1. **安装** — `npm install -g @fitlab-ai/agent-infra`（或在 macOS 上使用 `brew install fitlab-ai/tap/agent-infra`，或使用 shell 脚本便捷封装）
2. **初始化** — 在项目根目录运行 `ai init`，生成 `.agents/.airc.json` 并安装种子命令
3. **渲染** — 在任意 AI TUI 中执行 `update-agent-infra`，检测当前打包模板版本并生成所有受管理文件
4. **开发** — 使用内置 skill 驱动完整生命周期：`analysis → design → implementation → review → fix → commit`
5. **升级** — 有新模板版本时再次执行 `update-agent-infra` 即可

### 分层架构

```text
┌───────────────────────────────────────────────────────┐
│                     AI TUI Layer                      │
│  Claude Code  ·  Codex  ·  Gemini CLI  ·  OpenCode    │
└──────────────────────────┬────────────────────────────┘
                           │ slash 命令
                           ▼
┌───────────────────────────────────────────────────────┐
│                     Shared Layer                      │
│         Skills  ·  Workflows  ·  Templates            │
└──────────────────────────┬────────────────────────────┘
                           │ 渲染为
                           ▼
┌───────────────────────────────────────────────────────┐
│                    Project Layer                      │
│               .agents/  ·  AGENTS.md                  │
└───────────────────────────────────────────────────────┘
```

<a id="platform-support"></a>

## 平台支持

agent-infra 支持 macOS 和 Linux。CLI 本身只需要 Node.js (>=18)；容器相关功能（`ai sandbox *`）额外需要 Docker。

### macOS

- `ai init`、`ai sync` 等：执行 `npm install -g @fitlab-ai/agent-infra`（或 Homebrew 安装）后开箱即用。
- `ai sandbox *`：需要 Colima、OrbStack 或 Docker Desktop。macOS 默认引擎是 Colima —— 当选用 Colima 且宿主机没有 `colima` 命令时，agent-infra 会在首次运行时通过 Homebrew 自动安装并启动。如需使用 OrbStack 或 Docker Desktop，请在 `.agents/.airc.json` 中设置 `sandbox.engine`。

### Linux

- `ai init`、`ai sync` 等：执行 `npm install -g @fitlab-ai/agent-infra` 后开箱即用。
- `ai sandbox *`：需要宿主机已安装 Docker Engine。三步配置：

  ```bash
  # 1. 安装 Docker Engine —— 见 https://docs.docker.com/engine/install/
  # 2. 启动 daemon 并设置开机自启
  sudo systemctl enable --now docker
  # 3. 让当前用户免 sudo 跑 docker：加入 docker 组
  sudo usermod -aG docker $USER && newgrp docker
  ```

  验证：执行 `docker info` 应在不带 sudo 的情况下成功。

  当宿主机 `gpg-agent` 和签名 key 可用时，GPG signing 可正常工作；如果 key 同步失败，`ai sandbox create` 会回退到清理后的 Git config，让提交仍可在没有宿主签名状态的情况下继续。

#### Linux 已知限制

下列场景在本期未做主动验证：

- **Rootless Docker**：后续跟踪 [#256](https://github.com/fitlab-ai/agent-infra/issues/256)。
- 用 **Podman** 替代 Docker：后续跟踪 [#257](https://github.com/fitlab-ai/agent-infra/issues/257)。
- **SELinux enforcing** 宿主机（Fedora / RHEL）可能需要手动加挂载标签：后续跟踪 [#258](https://github.com/fitlab-ai/agent-infra/issues/258)。
- `ai sandbox vm` 在 Linux 上是空操作。Linux 直接使用 native Docker，没有 VM 需要管理；请直接使用 `ai sandbox create`、`ai sandbox exec`、`ai sandbox ls`、`ai sandbox rebuild`、`ai sandbox rm`。

### Windows

WSL2 支持在 [#184](https://github.com/fitlab-ai/agent-infra/issues/184) 跟踪。

<a id="what-you-get"></a>

## 安装效果

安装完成后，项目将获得完整的 AI 协作基础设施：

```text
my-project/
├── .agents/               # 共享 AI 协作配置
│   ├── .airc.json         # 中央配置文件
│   ├── workspace/         # 任务工作区（git 忽略）
│   ├── skills/            # 内置 AI skills
│   ├── workflows/         # 4 个预置工作流
│   └── templates/         # 任务与产物模板
├── .claude/               # Claude Code 配置与命令
├── .gemini/               # Gemini CLI 配置与命令
├── .opencode/             # OpenCode 配置与命令
└── AGENTS.md              # 通用 AI agent 指令
```

<a id="built-in-ai-skills"></a>

## 内置 AI Skills

agent-infra 提供 **丰富的内置 AI skills**。它们按使用场景分组，但共享同一个核心目标：无论使用哪种 AI TUI，都能在同一仓库里执行相同的工作流词汇和协作约定。

<a id="task-lifecycle"></a>

### 任务生命周期

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `create-task` | 根据自然语言请求创建任务骨架，并在平台规则可用时级联创建 Issue。 | `description` | 从零开始记录新功能、缺陷或改进需求。 |
| `import-issue` | 将 GitHub Issue 导入本地任务工作区。 | `issue-number` | 把已有 Issue 转成可执行的任务目录。 |
| `analyze-task` | 为已有任务输出需求分析产物。 | `task-id` | 在设计前明确范围、风险和受影响文件。 |
| `plan-task` | 编写技术实施方案，并设置人工审查检查点。 | `task-id` | 分析完成后定义具体实现路径。 |
| `implement-task` | 按批准方案实施并生成实现报告。 | `task-id` | 在方案获批后编写代码、测试和文档。 |
| `review-task` | 审查实现结果，并按严重程度分类问题。 | `task-id` | 合入前执行结构化代码审查。 |
| `refine-task` | 按优先级修复审查问题，不额外扩张范围。 | `task-id` | 根据 review 反馈完成修正。 |
| `complete-task` | 在所有关卡通过后标记任务完成并归档。 | `task-id` | 测试、审查和提交都完成后收尾。 |

<a id="task-status"></a>

### 任务状态

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `check-task` | 查看当前任务状态、工作流进度和下一步建议。 | `task-id` | 不修改任务状态，仅检查当前进展。 |
| `block-task` | 将任务标记为阻塞并记录阻塞原因。 | `task-id`、`reason`（可选） | 缺少外部依赖、决策或资源时暂停任务。 |
| `restore-task` | 从 GitHub Issue 同步评论中还原本地任务文件。 | `issue-number`、`task-id`（可选） | 换机器或清空本地状态后恢复任务工作区。 |

<a id="issue-and-pr"></a>

### Issue 与 PR

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `create-pr` | 向推断出的目标分支或显式指定分支创建 Pull Request。 | `task-id`（可选）、`target-branch`（可选） | 变更准备合入时创建 PR；清空上下文后也可显式传入任务关联。 |

<a id="code-quality"></a>

### 代码质量

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `commit` | 创建 Git 提交，并附带任务状态更新和版权年份检查。 | 无 | 在测试通过后固化一组完整变更。 |
| `test` | 运行项目标准验证流程。 | 无 | 修改后执行编译检查和单元测试验证。 |
| `test-integration` | 运行集成测试或端到端验证。 | 无 | 需要验证跨模块或整条流程行为时。 |

<a id="release-skills"></a>

### 发布

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `release` | 执行版本发布流程。 | `version`（`X.Y.Z`） | 发布新版本时。 |
| `create-release-note` | 基于 PR 和 commit 生成发布说明。 | `version`、`previous-version`（可选） | 发布前准备 changelog 时。 |
| `post-release` | 执行版本发布后的收尾工作（版本 bump、产物重建、可选动图录制）。 | 无 | 推送发布标签后完成收尾。 |

<a id="security-skills"></a>

### 安全

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `import-dependabot` | 导入 Dependabot 告警并创建修复任务。 | `alert-number` | 将依赖安全告警转入标准任务流程。 |
| `close-dependabot` | 关闭 Dependabot 告警并记录依据。 | `alert-number` | 告警经评估后无需处理时。 |
| `import-codescan` | 导入 Code Scanning 告警并创建修复任务。 | `alert-number` | 将 CodeQL 告警纳入常规修复流程。 |
| `close-codescan` | 关闭 Code Scanning 告警并记录依据。 | `alert-number` | 扫描告警可安全忽略时。 |

<a id="project-maintenance"></a>

### 项目维护

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `upgrade-dependency` | 将依赖从旧版本升级到新版本并验证结果。 | `package`、`old-version`、`new-version` | 进行受控的依赖维护时。 |
| `refine-title` | 将 Issue 或 PR 标题重构为 Conventional Commits 格式。 | `number` | GitHub 标题格式不规范时。 |
| `init-labels` | 初始化仓库标准 GitHub labels 体系。 | 无 | 新仓库首次配置 labels 时。 |
| `init-milestones` | 初始化仓库 milestones 结构。 | 无 | 新仓库首次建立里程碑时。 |
| `archive-tasks` | 将已完成任务按日期归档到目录中，并生成 `manifest` 索引。 | `[--days N \| --before DATE \| TASK-ID...]` | 需要定期清理 `completed/` 目录时。 |
| `update-agent-infra` | 将项目协作基础设施升级到最新模板版本。 | 无 | 需要刷新共享 AI 工具层时。 |

> 所有 skills 都可跨支持的 AI TUI 复用。变化的只是命令前缀，工作流语义保持一致。

<a id="custom-skills"></a>

## 自定义 Skills

内置 skills 覆盖了标准交付生命周期，但很多团队还需要项目特有的指令，例如编码规范、发布检查或内部审查规则。agent-infra 通过**自定义 skill**支持这些场景。

### 在项目中创建自定义 skill

在 `.agents/skills/<name>/` 下创建目录，并添加 `SKILL.md`：

```text
.agents/skills/
  enforce-style/
    SKILL.md
    reference/
      style-guide.md
```

最小 frontmatter 示例：

```yaml
---
name: enforce-style
description: "在提交代码前执行团队风格检查"
args: "<task-id>"   # 可选
---
```

- `name`：对用户可见的 skill 名称
- `description`：用于生成编辑器命令元数据
- `args`：可选参数提示；agent-infra 会在生成支持的 AI TUI 命令时使用它

添加 skill 后，再执行一次 `update-agent-infra`：

| TUI | 命令 |
|-----|------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Gemini CLI | `/{{project}}:update-agent-infra` |
| OpenCode | `/update-agent-infra` |

同步时会自动检测 `.agents/skills/` 下的非内置 skill 目录，并为 Claude Code、Gemini CLI、OpenCode 生成对应命令。

### 从共享源同步自定义 skills

如果团队在仓库外统一维护可复用 skill，可以在 `.agents/.airc.json` 中声明：

```json
{
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" },
      { "type": "local", "path": "~/team-skills" }
    ]
  }
}
```

源目录结构示例：

```text
~/private-skills/
  enforce-style/
    SKILL.md
  release-check/
    SKILL.md
    reference/
      checklist.md
```

行为说明：

- 多个 source 按数组顺序应用；后面的 source 如果定义了同名文件，会覆盖前面的自定义 source 文件
- 当前只支持 `type: "local"`；配置结构已为未来扩展其他来源类型预留
- source 路径中的 `~` 会自动展开为当前用户的 home 目录

### 同步行为与冲突规则

执行 `update-agent-infra` 时：

- 手动放在 `.agents/skills/` 下的自定义 skill 不会被 managed 文件清理删除
- 外部 source 中的 skill 会同步复制到 `.agents/skills/`
- 对于仍存在于配置 source 中的 skill，如果源里删掉某个文件，下次同步时本地对应残留文件也会被删除
- 内置 skill 始终优先于自定义 source；如果 source 里出现与内置 skill 同名的目录，agent-infra 会跳过该 source skill，而不是覆盖内置实现
- 如果你确实需要替换内置 skill 或命令，请使用现有的 `ejected` 机制，让项目自己接管该文件

## 自定义 TUI 配置

当团队使用的 AI TUI 不属于内置命令目标时，可以在 `.agents/.airc.json` 顶层配置 `customTUIs` 数组。该配置用于让 agent-infra 输出正确的下一步命令，并通过学习自定义 TUI 目录中的既有命令文件，为项目自定义 skill 生成同格式命令。

| 字段 | 必填 | 含义 |
|------|------|------|
| `name` | 是 | 报告和下一步提示中展示的工具名称，例如 `Acme TUI`。 |
| `dir` | 是 | 相对项目根目录的命令目录，例如 `.acme/commands`。路径必须位于项目根目录内。 |
| `invoke` | 是 | 面向用户展示的命令模板，用于生成下一步提示。 |

`invoke` 支持的占位符：

| 占位符 | 替换为 | 示例 |
|--------|--------|------|
| `${skillName}` | skill 命令名，例如 `review-task` 或 `commit`。 | `acme ${skillName}` -> `acme review-task` |
| `${projectName}` | `.airc.json` 中的 `project` 值，适用于带命名空间的命令。 | `/${projectName}:${skillName}` -> `/agent-infra:review-task` |

不带命名空间的自定义 TUI：

```json
{
  "customTUIs": [
    {
      "name": "Acme TUI",
      "dir": ".acme/commands",
      "invoke": "acme ${skillName}"
    }
  ]
}
```

带命名空间的自定义 TUI：

```json
{
  "project": "agent-infra",
  "customTUIs": [
    {
      "name": "Internal Gemini",
      "dir": ".internal-gemini/commands",
      "invoke": "/${projectName}:${skillName}"
    }
  ]
}
```

`customTUIs` 每个条目对应一个自定义 TUI。若希望 `update-agent-infra` 为自定义 skill 生成命令文件，请在 `dir` 中保留至少一个引用内置 skill 路径的既有命令文件，例如 `.agents/skills/analyze-task/SKILL.md`；agent-infra 会以该文件作为格式参考。

<a id="prebuilt-workflows"></a>

## 预置工作流

agent-infra 内置 **4 个预置工作流**。其中 3 个共享同一条分阶段交付链路：

`analysis -> design -> implementation -> review -> fix -> commit`

第 4 个 `code-review` 则更轻量，专门用于审查已有 PR 或分支。

| Workflow | 适用场景 | 步骤链 |
|----------|----------|--------|
| `feature-development` | 开发新功能或新能力 | `analysis -> design -> implementation -> review -> fix -> commit` |
| `bug-fix` | 诊断并修复缺陷，同时补回归验证 | `analysis -> design -> implementation -> review -> fix -> commit` |
| `refactoring` | 进行应保持行为稳定的结构性重构 | `analysis -> design -> implementation -> review -> fix -> commit` |
| `code-review` | 审查已有 Pull Request 或分支 | `analysis -> review -> report` |

### 生命周期示例

最简单的端到端交付回路如下：

```text
import-issue #42                    从 GitHub Issue 导入任务
(或: create-task "添加暗色模式")      或直接从描述创建任务；平台规则支持时会级联创建 Issue
         |
         |  --> 得到任务 ID，例如 T1
         v
  analyze-task T1                   需求分析
         |
         v
    plan-task T1                    设计方案  <-- 人工审查
         |
         v
  implement-task T1                 编写代码与测试
         |
         v
  +-> review-task T1                自动代码审查
  |      |
  |   有问题?
  |      +--NO-------+
  |     YES          |
  |      |           |
  |      v           |
  |  refine-task T1  |
  |      |           |
  +------+           |
                     |
         +-----------+
         |
         v
      commit                        提交最终代码
         |
         v
  complete-task T1                  归档并完成
```

<a id="configuration-reference"></a>

## 配置参考

生成出的 `.agents/.airc.json` 是引导 CLI、模板系统和后续升级之间的中心契约。

### `.agents/.airc.json` 示例

```json
{
  "project": "my-project",
  "org": "my-org",
  "language": "en",
  "templateVersion": "v0.5.8",
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  },
  "customTUIs": [
    {
      "name": "Acme TUI",
      "dir": ".acme/commands",
      "invoke": "acme ${skillName}"
    }
  ],
  "files": {
    "managed": [
      ".agents/workspace/README.md",
      ".agents/skills/",
      ".agents/templates/",
      ".agents/workflows/",
      ".claude/commands/",
      ".gemini/commands/",
      ".opencode/commands/"
    ],
    "merged": [
      ".agents/README.md",
      ".gitignore",
      "AGENTS.md"
    ],
    "ejected": []
  }
}
```

### 字段说明

| 字段 | 含义 |
|------|------|
| `project` | 用于渲染命令、路径和模板内容的项目名。 |
| `org` | 生成元数据和链接时使用的 GitHub 组织或拥有者。 |
| `language` | 渲染模板时采用的项目主语言或区域设置。 |
| `templateVersion` | 当前安装的模板版本，用于升级和差异追踪。 |
| `templates` | 可选的外部模板叠加配置。 |
| `templates.sources` | 可选的外部模板源列表，按顺序应用。当前仅支持 `type: "local"`。 |
| `skills` | 可选的自定义 skill 同步配置。 |
| `skills.sources` | 可选的外部自定义 skill 源列表，按顺序应用。当前仅支持 `type: "local"`。 |
| `customTUIs` | 可选的顶层自定义 AI TUI 适配配置列表。 |
| `files` | 针对具体路径配置 `managed`、`merged`、`ejected` 三类更新策略。 |

### 外部模板与 skill 源

当团队在仓库外维护私有平台模板、私有规则或共享自定义 skill 时，可以使用外部源。你可以在 `agent-infra init` 时配置，也可以之后手动编辑 `.agents/.airc.json`：

```json
{
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" },
      { "type": "local", "path": "~/team-overrides/templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  }
}
```

模板源优先级是内置模板优先，外部源作为补充。外部源中与内置模板同路径的文件会被忽略，并记录到 `templateSources.conflicts`；多个外部源之间，后面的条目覆盖前面的条目，冲突同样会记录。Skill 源使用相同的本地源结构，但自定义 skill 不能替换内置 skill。

外部模板文件和 skill 脚本可能包含 AI 工作流会执行的 JavaScript 或 shell 命令。只使用可信的本地路径。

<a id="file-management-strategies"></a>

## 文件管理策略

每个生成路径都会绑定一种更新策略，它决定 `update-agent-infra` 之后如何处理该文件。

| 策略 | 含义 | 更新行为 |
|------|------|---------|
| **managed** | 文件完全由 agent-infra 管理 | 升级时重新渲染并覆盖 |
| **merged** | 模板内容与用户定制共存 | 通过 AI 辅助合并尽量保留本地新增内容 |
| **ejected** | 仅首次生成，之后归项目自己维护 | 后续升级永不触碰 |

### 策略配置示例

```json
{
  "files": {
    "managed": [
      ".agents/skills/",
      ".agents/workspace/README.md"
    ],
    "merged": [
      ".gitignore",
      "AGENTS.md"
    ],
    "ejected": [
      "docs/architecture.md"
    ]
  }
}
```

### 如何把文件从 `managed` 改为 `ejected`

1. 在 `.agents/.airc.json` 中把该路径从 `managed` 数组移除。
2. 将同一路径加入 `ejected` 数组。
3. 再次执行 `update-agent-infra`，让后续升级不再管理这个文件。

当某个文件一开始适合由模板控制，但后续逐渐演变成强项目定制内容时，这个做法最合适。

<a id="version-management"></a>

## 版本管理

agent-infra 通过 Git tag 和 GitHub release 使用语义化版本号。当前安装的模板版本记录在 `.agents/.airc.json` 的 `templateVersion` 字段中，方便人和 AI 工具在升级时都能基于同一个版本基线工作。

<a id="contributing"></a>

## 参与贡献

开发规范请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

<a id="license"></a>

## 许可协议

[MIT](License.txt)
