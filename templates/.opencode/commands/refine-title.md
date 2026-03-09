---
name: "refine-title"
description: "Deep-analyze Issue or PR content and reformat its title to Conventional Commits format"
usage: "/refine-title <id>"
---

# Refine Title Command

## Description

For the specified GitHub Issue or PR, read its detailed description (Body), labels (Labels), and code changes (if PR), deeply understand its intent, then generate a new title conforming to the `type(scope): subject` format and execute the modification.

## Execution Flow

### 1. Identify Target and Fetch Information

Determine whether the ID is an Issue or PR, and fetch detailed information.

```bash
# Try fetching Issue information
gh issue view <id> --json number,title,body,labels,state

# If it's a PR, or no Issue found but a PR with the same number exists, fetch PR information
gh pr view <id> --json number,title,body,labels,state,files
```

### 2. Smart Analysis

Analyze based on the fetched JSON data:

1.  **Determine Type**:
    - Read the "change type" or description in `body`.
    - Check `labels` (e.g., `type: bug` -> `fix`, `type: feature` -> `feat`).
    - If it's a PR, analyze `files` (only doc changes -> `docs`, only test changes -> `test`).

2.  **Determine Scope**:
    - Read the modules mentioned in `body`.
    - Check `labels` (e.g., `in: fit` -> `fit`).
    - If it's a PR, analyze `files` paths (e.g., `framework/fit/java/...` -> `fit`).

3.  **Generate Subject**:
    - **Ignore the original title** (to avoid interference), extract core intent directly from `body`.
    - Keep it concise, clear, and without trailing period.

### 3. Generate Suggestion and Interact

Output analysis results for user confirmation:

```text
🔍 Analyzing: Issue #<id> / PR #<id>

Current title: [original title]
--------------------------------------------------
🧠 Analysis basis:
- Original intent: (one-line summary extracted from Body)
- Inferred type: Fix (basis: label type:bug, Body keyword "fix")
- Inferred scope: fit (basis: file paths framework/fit/...)
--------------------------------------------------
✨ Suggested title: fix(fit): fix null pointer exception in concurrent scenario
```

Ask user: *"Confirm modification? (y/n)"*

### 4. Execute Modification

After user confirms (y), execute the command based on target type:

```bash
# If it's an Issue
gh issue edit <id> --title "<new-title>"

# If it's a PR
gh pr edit <id> --title "<new-title>"
```

## Parameters

- `<id>`: Issue or PR number (required).

## Usage Example

```bash
# Smart rename Issue #1024
/refine-title 1024
```

## Advantages

Compared to batch modification (`/normalize-titles`), this command:
1. **Corrects errors**: If the original title is "Help me", this command can read the content and change it to "fix(core): fix startup error".
2. **More precise Scope**: By analyzing PR file changes, it can automatically determine the correct scope without manual specification.
