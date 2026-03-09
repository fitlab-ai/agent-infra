---
name: refine-title
description: >
  Deeply analyze Issue or PR content and reformat the title to
  Conventional Commits format. Triggered when the user requests
  title optimization. Argument: issue or PR number.
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
- Keep concise (under 50 characters), English imperative mood, no trailing period

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

## Advantages

This skill:
1. **Fixes misleading titles**: Even if the original title is "Help me", it reads the body and generates a proper title like `fix(core): resolve startup error`
2. **Accurate scope**: By analyzing PR file changes, it can automatically infer the correct scope without manual specification

## Notes

- The subject should be extracted from the body content, not reformatted from the original title
- If the body is empty or insufficient, ask the user for clarification
- Follow project conventions for scope naming
