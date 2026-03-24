# 提交信息规则

在暂存文件或编写 commit message 之前先读取本文件。

## 分析变更并生成提交信息

```bash
git status
git diff
git log --oneline -5
```

生成 Conventional Commit：
- `<type>(<scope>): <subject>`
- `subject` 必须使用英文祈使句，且不超过 50 个字符
- 正文使用 2-4 条 bullet，说明改了什么以及为什么改

### 多 Agent 共同署名

如果该提交属于一个活动中的任务：
1. 读取 task.md 中的 `## Activity Log`
2. 从 `by {agent}` 中收集去重后的 agent 名称
3. 排除 `human`
4. 将 agent 映射为 `Co-Authored-By` 行

| Agent | Co-Authored-By 行 |
|---|---|
| `claude` | `Co-Authored-By: Claude <noreply@anthropic.com>` |
| `codex` | `Co-Authored-By: Codex <noreply@openai.com>` |
| `gemini` | `Co-Authored-By: Gemini <noreply@google.com>` |
| `opencode` | `Co-Authored-By: OpenCode <noreply@opencode.ai>` |

按以下规则构建 co-author 区块：
1. 当前执行的 agent 必须放在第一行
2. 其余参与过的唯一 agent 追加在后面
3. 如果当前 agent 已经出现在 Activity Log 中，不要重复追加同一行
4. 所有额外的 `Co-Authored-By` 行都要去重
5. 未知 agent 统一映射为 `Co-Authored-By: {Agent} <noreply@unknown>`

## 创建提交

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

- <bullet point 1>
- <bullet point 2>

Co-Authored-By: {Your Model Name} <noreply@provider.com>
<additional Co-Authored-By lines>
EOF
)"
```

重要约束：
- 只能添加明确指定的文件
- 不要使用 `git add -A` 或 `git add .`
- 不要提交任何敏感信息
- co-author 区块必须把当前 agent 放在第一行
