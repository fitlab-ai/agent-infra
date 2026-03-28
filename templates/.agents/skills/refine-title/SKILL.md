---
name: refine-title
description: "Rewrite an Issue or PR title in Conventional Commits format"
---

# Refine Title

Reformat the title of the specified Issue or PR to Conventional Commits format based on deep content analysis.

## Execution Flow

### 1. Identify Target and Fetch Information

Try to determine if the ID is an Issue or PR:

```bash
# Try Issue first
gh issue view <id> --json number,title,body,labels,state

# If not found or is a PR
gh pr view <id> --json number,title,body,labels,state,files
```

### 2. Analyze Content

Based on the fetched data:

**Determine Type**:
- Read body for change type indicators
- Check labels (e.g. `type: bug` -> `fix`, `type: feature` -> `feat`)
- If PR, analyze files (only docs changed -> `docs`, only tests -> `test`)

**Determine Scope**:
- Read body for module mentions
- Check labels for module indicators
- If PR, analyze file paths to infer affected module

**Generate Subject**:
- **Ignore the original title** (avoid bias) - extract core intent from body
- Keep concise (under 50 characters), use the content's original language (Chinese content stays Chinese, English content stays English), no trailing period

### 3. Present Suggestion

```
Analysis for Issue/PR #{id}:

Current title: {original title}
--------------------------------------------------
Analysis:
- Intent: {one-line summary from body}
- Type: {type} (basis: {evidence})
- Scope: {scope} (basis: {evidence})
--------------------------------------------------
Suggested title: {type}({scope}): {subject}
```

Ask user: "Apply this title? (y/n)"

### 4. Apply Change

If user confirms:

```bash
# For Issue
gh issue edit <id> --title "<new-title>"

# For PR
gh pr edit <id> --title "<new-title>"
```

### 5. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

If the skill updated an Issue title, explain that no extra sync command is required; continue with the workflow skill that matches the task's current stage.

If the skill updated a PR title, show:

```
Next step - sync task progress to the PR:
  - Claude Code / OpenCode: /sync-pr #{pr_number}
  - Gemini CLI: /{{project}}:sync-pr #{pr_number}
  - Codex CLI: $sync-pr #{pr_number}
```

## Advantages

This skill:
1. **Fixes misleading titles**: Even if the original title is "Help me", it reads the body and generates a proper title like `fix(core): resolve startup error` while keeping the subject in the content's original language
2. **Accurate scope**: By analyzing PR file changes, it can automatically infer the correct scope without manual specification

## Notes

- The subject should be extracted from the body content, not reformatted from the original title
- If the body is empty or insufficient, ask the user for clarification
- Follow project conventions for scope naming
