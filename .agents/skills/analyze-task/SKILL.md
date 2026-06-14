---
name: analyze-task
description: "分析任务并输出需求分析文档"
---

# 分析任务

## 行为边界 / 关键规则

- 本技能仅产出需求分析文档（`analysis.md` 或 `analysis-r{N}.md`）—— 不修改任何业务代码
- 严格基于 `task.md` 中已有的需求、上下文和来源信息展开分析
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 执行步骤
### 1. 验证前置条件

检查必要文件：
- `.agents/workspace/active/{task-id}/task.md` - 任务文件

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果缺少 `task.md`，提示用户先创建或导入任务。

### 2. 确定分析轮次

扫描 `.agents/workspace/active/{task-id}/` 目录中的分析产物文件：
- 如果不存在 `analysis.md` 且不存在 `analysis-r*.md` → 本轮为第 1 轮，产出 `analysis.md`
- 如果存在 `analysis.md` 且不存在 `analysis-r*.md` → 本轮为第 2 轮，产出 `analysis-r2.md`
- 如果存在 `analysis-r{N}.md` → 本轮为第 N+1 轮，产出 `analysis-r{N+1}.md`

记录：
- `{analysis-round}`：本轮分析轮次
- `{analysis-artifact}`：本轮分析产物文件名

### 3. 阅读任务上下文

仔细阅读 `task.md` 以理解：
- 任务标题、描述和需求列表
- 上下文信息（Issue、PR、分支、告警编号等）
- 当前已知的受影响文件和约束

如 `task.md` 包含以下来源字段，补充读取对应来源信息：
- `issue_number` - Issue
- `codescan_alert_number` - Code Scanning 告警
- `security_alert_number` - Dependabot 告警

**Round ≥ 2：响应上一轮审查（仅当存在审查产物时）**：若任务目录存在 `review-analysis.md` / `review-analysis-r{N}.md`，读取最高轮次的审查报告；在本轮分析产物中新增 `## 对上一轮审查的响应` 段，对每条发现先 Read/Grep 核实再处置（成立 → 接受并修正；判定为幻觉/不成立 → 附反证反驳，不默认顺从），未决分歧写入 `## 未决问题`。Round 1 无审查，跳过本段。

### 4. 执行需求分析

开始分析前：若 frontmatter 的 `start_date` 为空，立即写入当日日期（命令 `date +%F`，格式 `YYYY-MM-DD`）；已有值则保留。写入前先读取 `.agents/rules/version-stamp.md`，并同步刷新 `updated_at` / `agent_infra_version`。

遵循 `.agents/workflows/feature-development.yaml` 中的 `analysis` 步骤：

**必要任务**（仅分析，不编写业务代码）：
- [ ] 理解任务需求和目标
- [ ] 搜索相关代码文件（**只读**）
- [ ] 分析代码结构和影响范围
- [ ] 识别潜在技术风险和依赖
- [ ] 评估工作量和复杂度

### 5. 输出分析文档

创建 `.agents/workspace/active/{task-id}/{analysis-artifact}`。

## 输出模板

```markdown
# 需求分析报告

- **分析轮次**：Round {analysis-round}
- **产物文件**：`{analysis-artifact}`

## 状态核对

> 粘贴第 0 步状态核对命令原文；每条命令以 `$ ` 开头。

## 需求来源

**来源类型**：{用户描述 / Issue / Code Scanning / Dependabot / 其他}
**来源摘要**：
> {任务来源或关键上下文}

## 需求理解
{用自己的话重述需求以确认理解}

## 相关文件
- `{file-path}:{line-number}` - {描述}

## 影响评估
**直接影响**：
- {受影响的模块和文件}

**间接影响**：
- {可能受影响的其他部分}

## 技术风险
- {风险描述和缓解思路}

## 依赖关系
- {需要的依赖和与其他模块的协调}

## 假设

> 如本次分析依赖某些假设，列在此处；没有则可省略本段。

- {本轮分析所依赖的假设}

## 未决问题

> 如有需要人工裁定的未决问题，列在此处；没有则可省略本段。

- {未决问题}

## 工作量和复杂度评估
- 复杂度：{高/中/低}
- 风险等级：{高/中/低}
```

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- 记录本轮分析产物：`{analysis-artifact}`（Round `{analysis-round}`）
- 如任务模板包含 `## 分析` 段落，更新为指向 `{analysis-artifact}` 的链接
- 在工作流进度中标记 requirement-analysis 为已完成，并注明实际轮次（如果任务模板支持）
- 在追加工作流 Activity Log 条目之前，基于分析结果（业务影响、风险、依赖、阻塞条件）重估 `priority`。若重估值与 `task.md` 当前值不一致：
  - 用新值覆盖 frontmatter 的 `priority` 字段
  - 在本轮分析产物 `{analysis-artifact}` 中追加 `## 优先级重估` 段，记录一条：`priority {old} → {new} (rationale: {基于本轮分析的简短依据})`
  若重估值与当前值一致，跳过：不写入 `## 优先级重估` 段。后续 Flow A 同步会读取可能更新过的 frontmatter，并自动把新值同步到 Issue。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Analyze Task (Round {N})** by {agent} — Analysis completed → {analysis-artifact}
  ```

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测
- 按 issue-sync.md 设置 `status: pending-design-work`
- 创建或更新 `.agents/rules/issue-sync.md` 中定义的 task 评论标记（按 issue-sync.md 的 task.md 评论同步规则）
- 发布 `{analysis-artifact}` 评论
- 读取 `.agents/rules/issue-fields.md`，按流程 A 把 `task.md` 中所有非空的 Issue 字段（`priority`/`effort`/`start_date`/`target_date`）同步到 Issue（幂等；`has_push=false` 或取数/写入失败时跳过，不阻断）

### 7. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate analyze-task .agents/workspace/active/{task-id} {analysis-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染「下一步」命令前，先读取 `.agents/rules/next-step-output.md`，按其取短号片段把命令中的 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）。

输出格式：
```
任务 {task-id} 分析完成。

摘要：
- 分析轮次：Round {analysis-round}
- 相关文件：{数量}
- 风险等级：{评估}

产出文件：
- 分析报告：.agents/workspace/active/{task-id}/{analysis-artifact}

下一步 - 审查需求分析：
  - Claude Code / OpenCode：/review-analysis {task-ref}
  - Gemini CLI：/agent-infra:review-analysis {task-ref}
  - Codex CLI：$review-analysis {task-ref}
```

## 完成检查清单

- [ ] 阅读并理解了任务文件和来源信息
- [ ] 创建了分析文档 `.agents/workspace/active/{task-id}/{analysis-artifact}`
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 在工作流进度中标记了 requirement-analysis 为已完成
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，含自定义 TUI，不要筛选）
- [ ] **没有修改任何业务代码**

## 停止

完成检查清单后，**立即停止**。等待用户审查分析结果并手动调用 `plan-task` 技能。

## 注意事项

1. **前置条件**：必须已存在任务文件 `task.md`
2. **多轮分析**：需求变化或已有分析需要修订时，使用 `analysis-r{N}.md`
3. **职责单一**：本技能只负责分析，不设计方案、不实现代码

## 错误处理

- 任务未找到：提示 "Task {task-id} not found, please check the task ID"
