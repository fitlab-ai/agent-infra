# ai-collaboration-installer - AI 开发指南

本仓库包含 ai-collaboration-installer 模板和技能仓库，用于多 AI 协作基础设施。

## 快速开始命令

<!-- TODO: 在此添加你的项目构建命令 -->
```bash
# 示例（替换为你的项目命令）：
# npm install / mvn clean install / pip install -r requirements.txt
# npm run build / mvn package / make build
# npm test / mvn test / pytest
# npm run lint / mvn checkstyle:check / flake8
```

## 编码规范（必须遵守）

<!-- TODO: 在此添加你的项目编码规范 -->

### 版权头更新规则
修改任意带版权头的文件时，必须更新版权年份：
1. 先运行 `date +%Y` 获取当前年份（不要硬编码）
2. 更新格式示例（假设当前年份为 2026）：
   - `2024-2025` -> `2024-2026`
   - `2024` -> `2024-2026`

### 分支命名
使用项目前缀：`collaborator-feature-xxx`、`collaborator-bugfix-yyy`

## 项目结构

<!-- TODO: 在此添加你的项目目录结构 -->

## 测试要求

<!-- TODO: 在此添加你的项目测试框架和命令 -->

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

<!-- TODO: 在此添加你的项目技术栈 -->

---

**基于标准**: [AGENTS.md](https://agents.md) (Linux Foundation AAIF)
