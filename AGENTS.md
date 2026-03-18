# agent-infra - AI 开发指南

本仓库包含 agent-infra 模板和技能仓库，用于多 AI 协作基础设施。

## 快速开始命令

```bash
# 安装依赖：无需安装，仅使用 Node.js 内置模块

# 构建项目：无需构建，项目由 Node.js CLI 和模板文件组成

# 运行测试
node --test tests/*.test.js

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
├── templates/                     # 模板源文件（镜像项目目录结构）
├── tests/                         # 测试（Node.js 内置测试运行器）
├── install.sh                     # 引导安装脚本
├── .airc.json                     # 项目配置
└── package.json                   # npm 测试脚本定义
```

## 测试要求

- 测试框架：Node.js 内置测试运行器（`node:test`，需 Node.js >= 18）
- 运行命令：`node --test tests/*.test.js`
- 测试覆盖：模板文件完整性、CLI 初始化流程、占位符渲染验证

## 提交与 PR 规范

### 提交信息格式（Conventional Commits）
```
<type>(<scope>): <subject>

示例：
feat(module): add new feature
fix(module): fix critical bug
docs(module): update documentation
refactor(module): refactor internal logic
```

- **type**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **scope**: 模块名（可省略）
- **subject**: 英文，简洁祈使语气，不超过 50 字符

### PR 检查清单
提交 PR 前必须确保：
- [ ] 所有测试通过
- [ ] 代码检查通过
- [ ] 构建成功
- [ ] 公共 API 有文档
- [ ] 版权头年份已更新（如适用）

## 安全注意事项

- 不要提交敏感文件：`.env`, `credentials.json`, 密钥等
- 安全问题请按 `SECURITY.md` 指引私下提交（不要公开 Issue）

## 多 AI 协作支持

本项目支持 Claude Code、Codex、Gemini CLI、OpenCode 等多个 AI 工具协同工作。

**协作配置目录**：
- `.agents/` - AI 配置和工作流定义（版本控制）

**语言规范**：

项目代码层面统一使用**英文**，文档提供**多语言版本**（英文为主版本）。

| 场景 | 语言 | 说明 |
|------|------|------|
| 代码标识符、JSDoc/TSDoc | 英文 | 代码即文档 |
| CLI 帮助文本、错误信息 | 英文 | 面向所有用户 |
| Git commit message | 英文 | Conventional Commits 祈使语气 |
| 项目文档 | 英文（主） + 中文翻译 | 如 `README.md` + `README.zh-CN.md` |
| AI 回复 | 跟随用户输入语言 | 中文问→中文答 |

**技术栈**：Shell（POSIX sh）、Node.js（内置测试运行器 `node:test`）、Markdown、TOML、JSON

---

**基于标准**: [AGENTS.md](https://agents.md) (Linux Foundation AAIF)
