---
name: refine-title
description: "Rewrite an Issue or PR title in Conventional Commits format"
---

# Refine Title

Reformat the title of the specified Issue or PR to Conventional Commits format based on deep content analysis.

## Execution Flow

### 1. Identify Target and Fetch Information

Read `.agents/rules/issue-pr-commands.md` before this step, and follow its prerequisite steps to complete authentication and code-hosting platform detection.

Try to determine if the ID is an Issue or PR:
- first fetch Issue data by following the "Read an Issue" command in the rule file
- if the target is not an Issue or is actually a PR, fetch PR data by following the "Read a PR" command

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

If the user confirms:
- for an Issue, update the title by following the "Update Issues" command in `.agents/rules/issue-pr-commands.md`
- for a PR, update the title by following the "Update PRs" command in `.agents/rules/issue-pr-commands.md`

Title changes require write permission. Follow the permission-degradation rules in `.agents/rules/issue-pr-commands.md` and `.agents/rules/issue-sync.md`; if permission is unavailable, skip the change and inform the user.

### 5. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

If the skill updated an Issue title, explain that no extra sync command is required; continue with the workflow skill that matches the task's current stage.

If the skill updated a PR title, explain that `create-pr` now publishes the reviewer summary inline, so no extra sync command is needed; continue with the workflow skill that matches the task's current stage.

If title modification was skipped due to insufficient permissions, additionally remind the user that the suggested title can still be applied manually on the code-hosting platform page.

## Advantages

This skill:
1. **Fixes misleading titles**: Even if the original title is "Help me", it reads the body and generates a proper title like `fix(core): resolve startup error` while keeping the subject in the content's original language
2. **Accurate scope**: By analyzing PR file changes, it can automatically infer the correct scope without manual specification

## Notes

- The subject should be extracted from the body content, not reformatted from the original title
- If the body is empty or insufficient, ask the user for clarification
- Follow project conventions for scope naming
