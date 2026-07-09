---
name: entropy-check
description: >
  周期性审查 agent-infra 仓库软熵增并输出结构化熵减审查报告。
  当本仓库需要在发版前或维护窗口识别规则重叠、文档膨胀、死约定和版本散落风险时使用。
---

# 熵减审查

## 行为边界 / 关键规则

- 本技能是 agent-infra 仓库本地维护技能，不属于 `update-agent-infra` 分发模板。
- 本技能不修改业务代码、规则、skill 或文档；只创建一份审查报告。
- 报告写入 `.agents/workspace/logs/entropy-check/entropy-check-YYYYMMDD-HHMMSS.md`。
- 发现项只给出证据与建议，不自动创建任务、不自动改文件。
- 不确定的边界选择写入报告的 `## 人工裁决待办`，不中途向用户提问。

## 执行步骤

### 1. 创建报告目录并做状态核对

创建输出目录：

```bash
mkdir -p .agents/workspace/logs/entropy-check
```

运行并记录以下命令，原文写入报告 `## 状态核对`：

```bash
git status -s
git branch --show-current
date "+%Y-%m-%d %H:%M:%S%:z"
```

### 2. 读取审查参考

执行审查前先读取：

- `reference/checklist.md`
- `reference/report-template.md`

### 3. 收集证据

按 checklist 收集证据，至少覆盖：

- `.agents/rules/issue-sync.md`
- `.agents/rules/issue-pr-commands.md`
- `.agents/rules/issue-fields.md`
- `.agents/rules/pr-sync.md`
- `.agents/rules/pr-checks-commands.md`
- `.agents/rules/create-issue.md`
- `.agents/skills/*/SKILL.md`
- `templates/.agents/skills/**`
- `package.json`
- `.agents/.airc.json`
- 版本发布相关文档与脚本

使用 `rg`、`find`、`wc -l`、`git status` 等可复现命令收集证据，并把关键命令原文写入报告。

### 4. 执行语义审查

根据 `reference/checklist.md` 逐项判断是否存在软熵增：

- 规则职责重叠或边界漂移
- `SKILL.md` 膨胀且应拆分到 `reference/`
- over-design、死约定或重复规则
- bilingual 命名约定混用且缺少边界说明
- version 号散落导致漂移风险

每条发现必须包含证据、影响、建议和严重度。只有发版前必须处理的问题才标记为 `release-blocking`。

### 5. 写入报告

按 `reference/report-template.md` 创建报告：

```bash
report=".agents/workspace/logs/entropy-check/entropy-check-$(date "+%Y%m%d-%H%M%S").md"
```

报告必须保留结构化章节，便于发版流程引用报告路径并让维护者裁定后续任务。

### 6. 输出结论

输出报告路径和发现统计。若存在 `release-blocking` 发现，明确提示当前发版流程应先处理或由维护者裁定后继续。
