# 项目 - Claude Code 指令

本仓库使用 agent-infra 进行多 AI 协作基础设施管理。

## 快速命令

<!-- TODO: 在此添加你的项目构建命令 -->
```bash
# 安装依赖
# TODO: 你的安装命令

# 构建项目
# TODO: 你的构建命令

# 运行测试
# TODO: 你的测试命令

# 代码检查
# TODO: 你的 lint 命令
```

## 项目结构

<!-- TODO: 在此添加你的项目目录结构 -->

## 编码规范

<!-- TODO: 在此添加你的项目编码规范 -->

### 版权头更新
修改任意带版权头的文件时，必须更新版权年份：
1. 先运行 `date +%Y` 获取当前年份（不要硬编码）
2. 更新格式：`2024-2025` -> `2024-2026`（假设当前年份为 2026）

### 分支命名
使用项目前缀：`{{project}}-feature-xxx`、`{{project}}-bugfix-yyy`

## 测试要求

<!-- TODO: 在此添加你的项目测试框架和命令 -->

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
4. **任务语义识别**：自动识别用户意图（如"分析 issue 207" -> `/import-issue 207`；"分析任务 TASK-20260306-143022" -> `/analyze-task TASK-20260306-143022`）
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
/import-issue <number>      # 导入 GitHub Issue 为任务
/analyze-task <task-id>     # 分析任务需求
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
/import-dependabot <number> # 导入 Dependabot 告警
/close-dependabot           # 关闭 Dependabot 告警
/import-codescan <number>   # 导入 Code Scanning 告警
/close-codescan             # 关闭 Code Scanning 告警
```

### 工具
```bash
/init-milestones            # 初始化 GitHub Milestones
/init-labels                # 初始化 GitHub Labels
/refine-title               # 重构 Issue/PR 标题
/upgrade-dependency         # 升级依赖
/update-agent-infra  # 更新 AI 协作配置
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
