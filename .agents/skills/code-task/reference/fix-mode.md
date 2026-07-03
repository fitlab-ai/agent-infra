# 修复工作流

在修复阶段修改代码之前先读取本文件。

## 规划修复

**先逐条核实（动手前必做）**：对 `{review-artifact}` 的每一条发现，先 Read/Grep 其引用的 `file:line` 与对应 `git diff`，确认问题真实存在，再按 `.agents/rules/review-handshake.md` 的四态处置，并把处置 + 相称证据回写 task.md `## 审查分歧账本` 对应行（stage=code，round +1；对称证据：每态都要附证据，"接受"不是零成本默认）：
- `accepted` → 纳入下方分类与修复，证据指向修复点 `file:line`
- `adjusted` → 采用替代修法，附理由，待 review-code 复核确认
- `refuted` → 核实判定不成立 / 基于错误 `file:line` / 幻觉 → 不改代码，在报告 `## 对审查发现的逐条核实` 给出反证，待 review-code 复核确认
- `cannot-judge` → 证据不足无法判断，交检视方/人工
- 不擅自把修复扩大到审查未列出的问题

按以下顺序分类并确定优先级：
1. **先处理 Blocker**
2. **再处理 Major**
3. **最后处理 Minor**

对每一个问题，都要明确：
- 哪些文件必须修改
- 具体需要怎样修复
- 如何验证修复已经生效

详细优先级规则：
- 所有 Blocker 都必须最先修完
- 只要没有被 Blocker 阻塞，所有 Major 都应在同一轮一并修复
- 只有在 Blocker 和 Major 都解决后，Minor 才是可选项
- 如果你不同意某条审查意见，或核实后判定为幻觉，不要静默跳过，而是在报告 `## 对审查发现的逐条核实` 给出反证并记录到 unresolved issues

### 元类目：manual-validation

manual-validation 项不在修复范围。处理规则：
- 不要为这些项编写代码改动
- 在 code 报告的「人工校验项处理」段落原样列出，标注「不在 AI 修复范围」
- 不要在 unresolved 段落里重复列出（避免视觉计数翻倍）
- 这些项的去向：维护者在 PR description 中以「待人工验证」清单承接

## 执行修复

对每一项修复：
1. 读取受影响文件
2. 施加最小必要改动
3. 验证改动确实解决了审查反馈
4. 运行项目测试的 **smoke 子集**做即时反馈（参见 `test` skill）

## 运行测试验证

写 code 报告前，运行项目测试的 **core 子集**做最终验证，确保所有必需测试仍然通过。如果项目没有分层 script，回退到完整项目测试命令。

## 选择下一步分支

判断规则：
1. 始终将重新审查作为默认推荐的下一步，无论本轮修复了哪个级别的问题
2. 直接提交仅可作为附加选项，且仅在所有问题均已解决且改动明显低风险时
3. 如果仍有任何 `Blocker` 或 `Major` 未解决，不要提供直接提交选项

禁止规则：
- 绝对不要把直接提交写成唯一下一步——重新审查必须始终作为首要推荐

必用输出模板：

```text
任务 {task-id} 修复完成。

修复情况：
- 阻塞项修复：{数量}/{总数}
- 主要问题修复：{数量}/{总数}
- 次要问题修复：{数量}/{总数}
- [如 manual-validation > 0] 人工校验项跳过：{数量}
- 所有测试通过：{是/否}
- 审查输入：{review-artifact}
- 修复产物：{code-artifact}

下一步 - 重新审查或提交：
- 重新审查（始终推荐）：
  - Claude Code / OpenCode：/review-code {task-ref}
  - Gemini CLI：/agent-infra:review-code {task-ref}
  - Codex CLI：$review-code {task-ref}
- 直接提交（可选；仅在所有问题已解决且风险可控时）：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

## 注意事项

1. **前置条件**：必须存在代码审查产物（`review-code.md` 或 `review-code-r{N}.md`）
2. **禁止自动提交**：不要执行 `git commit`
3. **范围约束**：逐条核实审查列出的问题，成立则修复、不成立则反驳；不扩大到审查未列出的问题
4. **分歧处理**：如果不同意审查意见，要在报告里明确记录
5. **重新审查**：修复后始终推荐执行 `review-code`
6. **一致性**：最新审查产物、Activity Log 记录和修复报告必须引用同一轮次
