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

可用命令从 `.claude/commands/` 自动发现。在提示符中输入 `/` 查看完整列表和描述。

任务工作流的典型顺序：
`/create-task` -> `/analyze-task` -> `/plan-task` -> `/implement-task` -> `/review-task` -> `/complete-task`

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
- `.agents/workspace/` - 任务工作区（已被 git ignore）

**协作指南**：`.agents/README.md`

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

- SKILL.md 正文控制在约 500 tokens（约 80 行 / 2KB）以内。
- 超过阈值的内容拆分到同级 `reference/` 目录。
- 骨架中使用明确导航，例如：`执行此步骤前，先读取 reference/xxx.md。`
- 长脚本继续放在 `scripts/` 目录，优先执行脚本而不是内联大段 bash。

<!-- Canonical source: .agents/README.zh-CN.md - keep in sync -->

## 安全注意事项

- 不要提交：`.env`、credentials、密钥
- 安全问题请按 `SECURITY.md` 指引
