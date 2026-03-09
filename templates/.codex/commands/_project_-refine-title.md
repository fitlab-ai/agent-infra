---
description: Deep-analyze Issue or PR content and reformat title to Conventional Commits format
argument-hint: <id>
---

For GitHub Issue or PR #$1, read its detailed description, labels, and code changes, deeply understand its intent, then generate a new title conforming to the type(scope): subject format and execute the modification.

Execute the following steps:

1. Identify object and fetch information:
   First try to fetch as Issue:
   ```bash
   gh issue view $1 --json number,title,body,labels,state
   ```
   If failed, try to fetch as PR:
   ```bash
   gh pr view $1 --json number,title,body,labels,state,files
   ```

2. Intelligent analysis:
   2.1 Determine Type: read body, check labels (bug->fix, feature->feat), analyze files
   2.2 Determine Scope: analyze affected modules
   2.3 Generate Subject: extract core intent from body (ignore original title), concise description within 20 characters

3. Generate suggestion and interact:
   ```
   Analysis target: Issue/PR #$1
   Current title: <original title>
   Analysis basis: <reasoning for type and scope>
   Suggested title: <type>(<scope>): <subject>
   ```
   Ask user: "Confirm modification? (y/n)"

4. Execute modification:
   Issue: `gh issue edit $1 --title "<new-title>"`
   PR: `gh pr edit $1 --title "<new-title>"`

5. Inform user:
   ```
   Title updated
   Old title: <old>
   New title: <new>
   ```

**Notes**:
- Must analyze content first; do not directly use the original title
- Ensure user confirmation before executing modification
