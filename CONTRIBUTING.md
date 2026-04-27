# 开发者指导手册

## 简介

本指导手册旨在为项目的开发者提供一份详细的开发指导，包括分支管理、标签管理、提交规则、代码审查等内容。遵循这些指导有助于项目的高效开发和良好协作。

## 开发模式

我们使用 [Git](https://git-scm.com/) 作为版本控制工具，项目开发模式遵从多版本的 `Git-Flow` 模式：

- `main` 分支为主干开发分支，所有特性都从该分支检出并合入
- `agent-infra-feature-*` 分支为特性开发分支
- `agent-infra-{$majorVersion}.{$minorVersion}.x` 为指定版本分支
- `agent-infra-bugfix-*` 分支为问题修复分支
- 所有问题修复或者功能增强，均需要找到合适的最低版本分支进行处理，然后逐级分支往上合入，最终合入 `main` 分支

## 环境配置

### 前置条件

- Git
- Node.js >= 18（用于内置测试运行器 `node:test`）
- Shell（sh/bash/zsh）

### 快速开始

```bash
# 克隆项目
git clone git@github.com:fitlab-ai/agent-infra.git

# 安装依赖：开发检出后必须先安装真实 npm 依赖
npm install

# 启用 Git hooks（仅首次 clone 后执行一次）
git config core.hooksPath .git-hooks

# 构建（修改 src/ 或 lib/ 后需要运行）
npm run build

# 运行测试
npm test

# 代码检查：暂未配置 lint 工具
```

请参考项目的 `README.md` 文件以获取更多关于如何配置开发环境的指导。

## 分支管理

- 为每个功能或问题修复创建一个新的分支，避免在主分支（如 `main`）上直接开发。
- 分支命名应简洁明了，描述分支的主要目的。
  - 分支以 `agent-infra-` 开头。
  - 特性分支以 `agent-infra-feature-` 开头，功能增强分支以 `agent-infra-enhancement-` 开头，任务型分支以 `agent-infra-task-` 开头，问题修复分支以 `agent-infra-bugfix-` 开头。
  - 使用短划线 `-` 来分隔单词。
  - 版本分支最后跟两个版本号和一个 `x` 字母，例如：`agent-infra-1.0.x`。
  - 发布分支后面跟三个版本号，例如：`agent-infra-1.0.0`。

### 版本分支合并规则

- 版本分支合并必须遵循低版本向高版本合并的原则，且不可跨越某一个版本。
- 当任意 `feature`、`enhancement` 或 `bugfix` 合入指定版本分支之后，需要依次向上合并直到 `main` 分支为止。

## 标签管理

- 每个标签的名字和发布分支的名字需要保持一致，例如：`agent-infra-1.0.0`。
- 纯数字版本的分支需要以 `v` 开头，例如：`v0.1.0`。
- 候选版本以特殊词组结尾，例如：`agent-infra-1.0.0-alpha1`。
- 当标签被打出后，对应的发布分支应当删除。
- 所有的 Issue 和 PR 都需要至少包含两种标签：`in: {$module}` 和 `type: {$type}`。

## 开发规范

### 代码风格

- `install.sh` 保持 POSIX sh 兼容，使用 `set -e` 进行错误处理
- 模板文件使用 `{{project}}` 和 `{{org}}` 作为渲染占位符
- 面向用户的 Markdown 文件提供双语版本（英文为主 + 中文翻译），如 README、SECURITY

### 平台无关层与平台层

本仓库的模板需要区分平台无关 baseline 与平台特定实现。平台特定内容只能放在以下位置：

- `.agents/rules/*.{platform}.md`
- `.agents/scripts/platform-adapters/platform-sync.{platform}.js`
- 明确属于平台集成的脚本或工作流目录

除上述位置外，`SKILL.md`、`reference/*.md`、命令面板、QUICKSTART、README 等 baseline 文件必须保持平台无关。baseline 文件应引用 `.agents/rules/*.md` 或 `.agents/scripts/` 中的抽象入口，不直接写入平台命令、路径或 schema。

判断平台耦合时，先检查这些硬指标：

- 平台名，如 `GitHub`
- 平台路径，如 `.github/`
- 平台 CLI，如 `gh CLI` 或以 `gh ` 开头的命令

还要人工检查这些软指标：

- 平台特定 schema 字段名，如 GitHub Issue Forms 的 `textarea`、`input`、`dropdown`、`checkboxes`、`attributes.label`
- 平台文件命名约定，如 `.yml` Issue Form 文件名、`PULL_REQUEST_TEMPLATE.md`
- 已在 rules/scripts 中定义过的命令或 marker 字符串副本

`tests/templates/platform-coupling.test.js` 提供结构性护栏：baseline 文案不得含平台硬指标，skill reference 目录不得新增 `.github.*` 这类平台变体。测试不能覆盖所有软指标，PR 作者和 reviewer 仍需人工检查 schema 字段、命令重复和措辞包装。

### 路径级平台门控（init/sync 实施层）

`templates/` 下顶层段为 `.{platform}/` 的路径（如 `.github/`、未来的 `.gitlab/`）由 `src/sync-templates.js` 按 `cfg.platform.type` 自动门控分发：

- 当 `cfg.platform.type` 等于该 platform：正常分发与同步
- 当 `cfg.platform.type` 是其他 `KNOWN_PLATFORMS` 值或自定义平台：跳过分发，并清理项目中残留的同名目录条目

项目级（非平台特定）的 git hooks、配置等不应放在 `.{platform}/` 下；放在平台中性路径（如 `.git-hooks/`）才能跨平台分发。

示例：

- 反例：在 `templates/.agents/skills/create-pr/reference/pr-body-template.en.md` 中直接写 `gh pr list --limit 3 --state merged`
- 正例：baseline reference 写“按 `.agents/rules/issue-pr-commands.md` 的最近 PR 查询命令执行”，GitHub 具体命令只放在 `issue-pr-commands.github.en.md`

已采纳的架构决策：

- `verify.json` 应优先通过 `expected_*_key` 引用平台 adapter 的默认值，而不是复制 marker 或 status label 字符串。
- `platform-sync.{platform}.js#getDefaults()` 是平台默认 marker 和 status label 的单一信息源。
- 这个 key-based 抽象是为多平台扩展保留的设计：把 N 个 skill × M 个平台的配置成本收敛为 N 个 key 引用 + M 个 adapter 默认值。

### 构建架构

- `src/sync-templates.js` 是开发源码，保留可读的源码结构和对 `lib/` 数据文件的标准读取方式。
- `templates/.agents/skills/update-agent-infra/scripts/sync-templates.js` 是构建产物，发布时会把默认配置和版本号内联为常量。
- 之所以需要这层构建，是因为 `sync-templates.js` 会被复制到用户项目中运行，届时不能再依赖 installer 仓库里的 `lib/` 目录。
- 修改 `src/`、`lib/defaults.json` 或相关版本信息后，应执行 `npm run build` 重新生成产物，不要直接手工编辑 `templates/` 下的生成文件。

### 注释信息

- 每一个模块文件都建议包含注释，说明其职责和用途。
- 所有被 `export` 的类、函数、接口等都需要添加文档注释。

## 提交规则

### 提交信息格式

我们采用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：
`<type>(<scope>): <subject>`

- **type（类型）**：`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
- **scope（范围/模块）**：对应项目模块名。如果涉及多个模块或全局变动，可以使用 `*` 或留空。
- **subject（描述）**：简短描述主要内容，使用英文祈使语气，不超过 50 字符，结尾不需要句号。

**样例：**
- `feat(ai): add multi-agent collaboration workflow`
- `fix(github): fix PR title validation regex`
- `docs(ai): update collaboration quick start guide`

## 代码审查

- 开发完成后，通过创建合并请求将变更合并到主分支。在合并请求中描述所做的更改，并邀请其他项目成员进行代码审查。
- 保持主分支始终可部署，确保合并的代码经过充分测试。

## 测试

- 测试框架：Node.js 内置测试运行器（`node:test`，需 Node.js >= 18）
- 构建命令：`npm run build`（修改 `src/`、`lib/defaults.json` 或版本信息后需要运行）
- 运行命令：`npm test`
- 等价于：`node scripts/build-inline.js --check && node --test tests/*.test.js`
- 测试覆盖：模板文件完整性、CLI 初始化流程、占位符渲染验证
- 提交前务必确保所有测试通过

## 发布流程

遵循项目的发布计划和流程。在发布新版本时，请按照标签管理的规定创建一个新的 `tag`。

## 问题和需求跟踪

使用项目的 `Issue` 跟踪器来报告和跟踪问题、需求和功能建议。在创建新 `Issue` 时，请尽量提供详细的信息。

## 贡献指南

对于希望参与项目的贡献者，请遵循以下步骤：

1. Fork 当前项目。
2. 克隆 Fork 后的仓库到本地。
3. 在本地仓库中创建一个新的分支，进行开发。
4. 遵循本文档中的提交规范，将更改提交到新分支。
5. 通过页面创建一个 PR，请求将更改合并到该项目的对应分支，PR 中仅能包含一次提交。
6. 参与代码审查和讨论，根据反馈进行必要的修改。
7. 一旦更改被接受并合并，您的贡献将成为项目的一部分。

> - 项目维护者可能会提出修改建议，请保持开放态度并积极沟通。
> - 如果您发现了一个问题但并不准备自己修复，可以仅提交一个 Issue。如果对方案存在疑问，可以在"讨论"模块中提问。
