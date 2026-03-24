# Command Style Guide

This guide defines conventions for writing OpenCode command files in the `.opencode/commands/` directory.

## File Format

Every command file uses Markdown with YAML frontmatter:

```markdown
---
description: Brief one-line description
agent: general
subtask: false
---

Command instructions here.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | One-line summary (under 80 chars) |
| `agent` | Yes | Always `general` unless specialized |
| `subtask` | Yes | `false` for top-level commands |

## Executable Commands vs Code Blocks

### Use `!` prefix for commands that MUST be executed

```markdown
!date -u +"%Y-%m-%dT%H:%M:%SZ"
!git status --short
!gh issue view 123 --json number,title,body
```

The `!` prefix tells OpenCode to run the command directly. Use this for:
- Getting dynamic information (timestamps, git status)
- Performing actions (creating files, calling APIs)
- Running build/test commands

### Use markdown code blocks for illustrative examples

````markdown
Example output format:
```
Task ID: TASK-20260101-120000
Status: active
```
````

Code blocks are NOT executed. Use them for:
- Showing expected output formats
- Documenting templates
- Illustrating patterns the AI should follow

## Parameter Handling

### Positional parameters

Reference with `$ARGUMENTS`:

```markdown
Parse the task ID from `$ARGUMENTS`.
```

### Validation

Always validate required parameters early:

```markdown
If `$ARGUMENTS` is empty, respond:
"Please provide a task ID. Example: /check-task TASK-20260101-120000"
Then STOP.
```

## Timestamp Handling

**NEVER** hardcode dates or years.

Correct:
```markdown
!date -u +"%Y-%m-%dT%H:%M:%SZ"
```

Wrong:
```markdown
Set the date to 2026-03-06.
```

## GitHub API Paths

**ALWAYS** use `{owner}/{repo}` placeholders. Resolve dynamically:

```markdown
!gh api repos/{owner}/{repo}/dependabot/alerts/$ARGUMENTS
```

To get owner/repo:
```markdown
!gh repo view --json owner,name -q '.owner.login + "/" + .name'
```

## Step Numbering and Readability

### Use numbered steps for sequential operations

```markdown
## Steps

1. **Validate input** - Check that the task ID is provided.

2. **Read task file** - Find and read the task.md file.

3. **Update status** - Modify the task metadata.
```

### Use bold for step titles

Each step should have a clear bold title followed by a description.

### Keep steps atomic

Each step should do one thing. If a step is too complex, break it into sub-steps.

## Error Handling Patterns

### Check prerequisites before acting

```markdown
1. **Verify task exists**

Search for the task file:
- `.agents/workspace/active/{task-id}/task.md`
- `.agents/workspace/blocked/{task-id}/task.md`
- `.agents/workspace/completed/{task-id}/task.md`

If not found, respond:
"Task {task-id} not found. Please check the task ID."
Then STOP.
```

### Report errors clearly

```markdown
If the command fails, report:
- What went wrong
- Possible causes
- Suggested next steps

Do NOT silently continue.
```

## Common Patterns

### Task file lookup pattern

```markdown
Search for the task in this order:
1. `.agents/workspace/active/{task-id}/task.md`
2. `.agents/workspace/blocked/{task-id}/task.md`
3. `.agents/workspace/completed/{task-id}/task.md`
```

### Status update pattern

```markdown
Update `task.md` YAML frontmatter:
- `current_step`: {step-name}
- `assigned_to`: opencode
- `updated_at`: {current timestamp from date command}
```

### Next-step suggestion pattern

```markdown
**Next step:**
Use `/plan-task {task-id}` to design the technical plan.
```

## Anti-Patterns

### DO NOT

- Hardcode dates, years, or timestamps
- Hardcode repository owner/name in API paths
- Skip parameter validation
- Auto-commit without user confirmation
- Use tool-specific syntax (e.g., Claude's Read/Edit/Write tool names)
- Reference tech-stack-specific commands without TODO markers
- Include emoji in command files (keep them professional)
- Write overly long steps -- break them up

### DO

- Use `!` for all executable commands
- Validate parameters before proceeding
- Provide clear error messages
- Include "STOP" after error conditions
- Keep commands concise and scannable
- Use placeholders for project-specific values
- Add TODO markers for tech-stack-specific sections

## Tech-Stack Agnostic Commands

For commands that depend on the project's tech stack (build tools, test runners, package managers), use TODO markers:

```markdown
3. **Run tests**

<!-- TODO: Replace with your project's test command -->
!npm test
```

This tells users they need to customize the command for their project.

## Command Review Checklist

Before submitting a new command, verify:

- [ ] Frontmatter has `description`, `agent`, and `subtask`
- [ ] All executable commands use `!` prefix
- [ ] All illustrative examples use code blocks (no `!`)
- [ ] Parameters are validated with clear error messages
- [ ] Timestamps are generated dynamically
- [ ] GitHub API paths use `{owner}/{repo}` placeholders
- [ ] Steps are numbered and have bold titles
- [ ] Error cases are handled with "STOP" directives
- [ ] No hardcoded dates, repo names, or tool-specific references
- [ ] Tech-stack-specific sections have TODO markers
- [ ] Both EN and ZH-CN versions are created
- [ ] Command is concise -- no unnecessary prose
