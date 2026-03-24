# Commit Message Rules

Read this file before staging files or composing the commit message.

## Analyze Changes and Generate the Commit Message

```bash
git status
git diff
git log --oneline -5
```

Generate a Conventional Commit:
- `<type>(<scope>): <subject>`
- imperative English subject, under 50 characters
- 2-4 body bullets describing what changed and why

### Multi-Agent Co-Authorship

If the commit belongs to an active task:
1. read `## Activity Log` in task.md
2. collect unique agent names from `by {agent}`
3. exclude `human`
4. map agents to `Co-Authored-By` lines

| Agent | Co-Authored-By line |
|---|---|
| `claude` | `Co-Authored-By: Claude <noreply@anthropic.com>` |
| `codex` | `Co-Authored-By: Codex <noreply@openai.com>` |
| `gemini` | `Co-Authored-By: Gemini <noreply@google.com>` |
| `opencode` | `Co-Authored-By: OpenCode <noreply@opencode.ai>` |

Build the co-author block with these rules:
1. keep the current executing agent first
2. append other unique participating agents after it
3. if the current agent already appears in Activity Log, do not add a duplicate line
4. de-duplicate all additional `Co-Authored-By` lines
5. map unknown agents to `Co-Authored-By: {Agent} <noreply@unknown>`

## Create the Commit

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

Important:
- add specific files only
- do not use `git add -A` or `git add .`
- do not include secrets
- keep the current agent first in the co-author block
