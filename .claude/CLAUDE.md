# agent-infra - AI 开发指南

本仓库包含 agent-infra 模板和技能仓库，用于多 AI 协作基础设施。

## 快速开始命令

```bash
# 安装依赖：开发检出后必须先安装真实 npm 依赖
npm install

# 构建项目：无需构建，项目由 Node.js CLI 和模板文件组成

# 运行测试
npm test

# 代码检查：暂未配置 lint 工具
```

## 编码规范（必须遵守）

- `install.sh` 保持 POSIX sh 兼容，使用 `set -e` 进行错误处理
- 模板文件使用 `{{project}}` 和 `{{org}}` 作为渲染占位符
- Markdown 文件提供双语版本（英文为主 + 中文翻译）

### 版权头更新规则
修改任意带版权头的文件时，必须更新版权年份：
1. 先运行 `date +%Y` 获取当前年份（不要硬编码）
2. 更新格式示例（假设当前年份为 2026）：
   - `2024-2025` -> `2024-2026`
   - `2024` -> `2024-2026`

### 分支命名
使用项目前缀：`agent-infra-feature-xxx`、`agent-infra-bugfix-yyy`

## 项目结构

```
├── bin/                           # CLI 可执行文件
│   └── cli.js                     # 主 CLI（Node.js）
├── .agents/                       # AI 协作配置与工作区
│   ├── .airc.json                 # 项目配置
│   ├── workspace/                 # 任务工作区
│   ├── skills/                    # 技能仓库
│   └── workflows/                 # 工作流定义
├── templates/                     # 模板源文件（镜像项目目录结构）
├── tests/                         # 测试（Node.js 内置测试运行器）
├── install.sh                     # 引导安装脚本
└── package.json                   # npm 测试脚本定义
```

## 测试要求

- 测试框架：Node.js 内置测试运行器（`node:test`，需 Node.js >= 18）
- 运行命令：`npm test`
- 测试覆盖：模板文件完整性、CLI 初始化流程、占位符渲染验证

### 测试编写规约

1. **禁止关键词语义断言**：不要通过匹配自然语言措辞来验证 skill 文档内容（如 `assert.match(content, /某段具体描述/)`）。SKILL.md 的文案会频繁调整，绑定措辞的测试极其脆弱。只做结构性检查：frontmatter 合法性、步骤编号连续、引用完整性、体积阈值等。
2. **禁止反向删除断言**：已删除的功能不需要断言其不存在（如 `assert.doesNotMatch(content, /removedField/)`）。删除即彻底删除，不要用测试永久记住一个不再存在的概念，否则会形成无止境的测试债务。

## 提交与 PR 规范

详见 `.agents/rules/commit-and-pr.md`（提交代码或创建 PR 时按需加载）。

## 安全注意事项

- 不要提交敏感文件：`.env`, `credentials.json`, 密钥等
- 安全问题请按 `SECURITY.md` 指引私下提交（不要公开 Issue）

## 多 AI 协作支持

本项目支持 Claude Code、Codex、Gemini CLI、OpenCode 等多个 AI 工具协同工作。

**协作配置目录**：
- `.agents/` - AI 配置和工作流定义（版本控制）

**协作指南**：`.agents/README.md`

**Skill 维护强制要求**：
- 修改或新增 `.agents/skills/*/SKILL.md` 及其模板前，必须先读取 `.agents/README.md` 中的 “Skill 编写规范” 和 “SKILL.md 体积控制” 章节。

## 语言规范

项目代码层面统一使用**英文**，文档提供**多语言版本**（英文为主版本）。
未在下表中列出的场景，默认使用中文。

| 场景 | 语言 | 说明 |
|------|------|------|
| 代码标识符、JSDoc/TSDoc | 英文 | 代码即文档 |
| CLI 帮助文本、错误信息 | 英文 | 面向所有用户 |
| Git commit message | 英文 | Conventional Commits 祈使语气 |
| 任务标题 | 跟随用户输入语言 | task.md 标题保持用户原文，不套用 Conventional Commits 格式 |
| GitHub Issue/PR 标题 | 英文前缀 + 跟随用户输入语言 | 格式：`type(scope): 中文描述`；type/scope 英文，描述保持原文 |
| 任务工作区产物 | 跟随已部署的技能语言 | `.agents/workspace/` 文件使用 `.airc.json` 选定的 SKILL.md 语言 |
| Activity Log 步骤名 | 英文 | 工具链使用的结构化标识符（如 `**Commit** by`） |
| 项目文档 | 英文（主） + 中文翻译 | 如 `README.md` + `README.zh-CN.md` |
| AI 回复 | 跟随用户输入语言 | 中文问→中文答 |

**提交代码或创建 PR 时**，必须先读取 `.agents/rules/commit-and-pr.md`。
**执行任务工作流命令时**，必须先读取 `.agents/rules/task-management.md`。
