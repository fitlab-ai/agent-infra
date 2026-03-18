# 项目 - Claude Code 指令

本仓库使用 agent-orchestrator 进行多 AI 协作基础设施管理。

## 快速命令

```bash
# 安装依赖：无需安装，仅使用 Node.js 内置模块

# 构建项目：无需构建，项目由 Node.js CLI 和模板文件组成

# 运行测试
node --test tests/*.test.js

# 代码检查：暂未配置 lint 工具
```

## 项目结构

```
├── bin/                           # CLI 可执行文件
│   └── cli.js                     # 主 CLI（Node.js）
├── templates/                     # 模板源文件（镜像项目目录结构）
│   ├── .agents/                   # AI 代理配置模板
│   ├── .claude/                   # Claude Code 配置模板
│   ├── .codex/                    # Codex 配置模板
│   ├── .gemini/                   # Gemini CLI 配置模板
│   ├── .opencode/                 # OpenCode 配置模板
│   ├── .github/                   # GitHub 配置模板
│   └── *.md                       # 根级模板文件
├── tests/                         # 测试（Node.js 内置测试运行器）
├── install.sh                     # 引导安装脚本
├── .aorc.json                     # 项目配置
└── package.json                   # npm 测试脚本定义
```

## 编码规范

- `install.sh` 保持 POSIX sh 兼容，使用 `set -e` 进行错误处理
- 模板文件使用 `{{project}}` 和 `{{org}}` 作为渲染占位符
- Markdown 文件提供双语版本（英文为主 + 中文翻译）

### 版权头更新
修改任意带版权头的文件时，必须更新版权年份：
1. 先运行 `date +%Y` 获取当前年份（不要硬编码）
2. 更新格式：`2024-2025` -> `2024-2026`（假设当前年份为 2026）

### 分支命名
使用项目前缀：`agent-orchestrator-feature-xxx`、`agent-orchestrator-bugfix-yyy`

## 测试要求

- 测试框架：Node.js 内置测试运行器（`node:test`，需 Node.js >= 18）
- 运行命令：`node --test tests/*.test.js`
- 测试覆盖：模板文件完整性、CLI 初始化流程、占位符渲染验证

## 提交与 PR 规范

### 提交信息格式（Conventional Commits）
```
<type>(<scope>): <subject>
```
- **type**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **scope**: 模块名（可省略）
- **subject**: 英文，简洁祈使语气，不超过 50 字符

### Claude 提交署名
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

### PR 检查清单
- [ ] 测试通过
- [ ] 代码检查通过
- [ ] 构建成功
- [ ] 公共 API 有文档
- [ ] 版权头年份已更新

## Claude 特定规则

### 关键规则
1. **禁止自动提交**：绝对不要自动执行 `git commit`/`git add`，提醒用户使用 `/commit`
2. **版权年份更新**：运行 `date +%Y` 获取当前年份，使用 Edit 工具更新
3. **任务状态管理**：执行命令后更新 `task.md` 字段

### 重要规则
4. **任务语义识别**：自动识别用户意图（如"分析 issue 207" -> `/import-issue 207`，"分析任务 TASK-xxx" -> `/analyze-task TASK-xxx`）
5. **PR 规范**：创建 PR 时添加生成标记

**详细规则**：`.claude/project-rules.md`

## 工具使用偏好

| 操作 | 推荐 | 不推荐 |
|------|------|--------|
| 文件搜索 | `Glob` | `find`、`ls` |
| 内容搜索 | `Grep` | `grep`、`rg` |
| 读取文件 | `Read` | `cat`、`head`、`tail` |
| 编辑文件 | `Edit` | `sed`、`awk` |
| 创建文件 | `Write` | `echo >`、`cat <<EOF` |

**Bash 仅用于**：Git 操作、构建/测试、系统信息查询

## Slash Commands

### 开发相关
```bash
/commit [message]           # 提交代码
/create-pr [branch]         # 创建 PR
```

### 任务管理
```bash
/create-task <description>  # 创建任务
/analyze-task <task-id>     # 分析任务
/import-issue <number>      # 导入 Issue
/plan-task <task-id>        # 设计方案
/implement-task <task-id>   # 实施任务
/review-task <task-id>      # 代码审查
/complete-task <task-id>    # 完成任务
/check-task <task-id>       # 查看状态
/block-task <task-id>       # 阻塞任务
/refine-task <task-id>      # 处理审查反馈
```

### PR 与同步
```bash
/sync-issue <number>        # 同步进度到 Issue
/sync-pr <number>           # 同步进度到 PR
```

### 测试与发布
```bash
/test                       # 运行测试
/test-integration           # 运行集成测试
/release <version>          # 版本发布
/create-release-note        # 生成发布说明
```

### 安全
```bash
/import-dependabot          # 导入 Dependabot 告警
/close-dependabot           # 关闭 Dependabot 告警
/import-codescan            # 导入 Code Scanning 告警
/close-codescan             # 关闭 Code Scanning 告警
```

### 工具
```bash
/init-milestones            # 初始化 GitHub Milestones
/init-labels                # 初始化 GitHub Labels
/refine-title               # 重构 Issue/PR 标题
/upgrade-dependency         # 升级依赖
/update-agent-orchestrator  # 更新 AI 协作配置
```

## 语言规范

| 场景 | 语言 |
|------|------|
| 代码标识符、文档 | 英文 |
| Git commit message | 英文 (Conventional Commits) |
| 项目文档 | 英文（主） + 中文翻译 |
| AI 回复 | 跟随用户输入语言 |

## 多 AI 协作

本项目支持 Claude Code、Codex、Gemini CLI、OpenCode。

- `.agents/` - 共享协作配置
- `.agent-workspace/` - 任务工作区（已被 git ignore）

**协作指南**：`.agents/README.md`

## 安全注意事项

- 不要提交：`.env`、credentials、密钥
- 安全问题请按 `SECURITY.md` 指引
