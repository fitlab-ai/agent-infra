# Quick Start: Multi-AI Collaboration

This guide walks you through using multiple AI coding assistants together on a project.

## Prerequisites

- At least one AI coding tool installed (Claude Code, Codex CLI, Gemini CLI, or Cursor)
- A project with `.agents/` directory set up (this project)
- Familiarity with your project's codebase

## Creating Your First Task

1. Copy the task template to the active workspace:

```bash
cp .agents/templates/task.md .ai-workspace/active/task-001.md
```

2. Fill in the task metadata:

```yaml
id: task-001
type: feature          # feature | bugfix | refactor | docs | review
status: open           # open | in-progress | review | blocked | completed
assigned_to: claude    # claude | codex | gemini | cursor | human
```

3. Describe the task in the body of the document.

## Using Different AIs for Different Phases

### Phase 1: Analysis (Recommended: Claude Code)

```bash
# Start Claude Code and ask it to analyze the task
claude

# Example prompt:
# "Analyze task-001. Explore the codebase and identify all files
#  that need to change. Update the task with your findings."
```

Claude Code excels at codebase exploration and understanding complex relationships between files.

### Phase 2: Design (Recommended: Claude Code or Gemini CLI)

```bash
# Continue with Claude Code or switch to Gemini CLI for large codebases
gemini

# Example prompt:
# "Based on the analysis in .ai-workspace/active/task-001.md,
#  create a technical design. Define interfaces and outline the approach."
```

### Phase 3: Implementation (Recommended: Codex CLI or Cursor)

```bash
# Switch to Codex CLI for implementation
codex

# Example prompt:
# "Implement the changes described in .ai-workspace/active/task-001.md.
#  Follow the design section. Create a new branch for this work."
```

### Phase 4: Review (Recommended: Claude Code)

```bash
# Switch back to Claude Code for review
claude

# Example prompt:
# "Review the implementation on branch feature-xxx.
#  Check for correctness, style, and best practices.
#  Create a review report."
```

## Common Scenarios

### Bug Fix

1. **Reproduce & Analyze** (Claude Code): Identify the root cause.
2. **Implement Fix** (Codex CLI / Cursor): Write the fix and tests.
3. **Review** (Claude Code): Verify the fix is correct and complete.
4. **Commit**: Create PR with bug fix description.

```bash
# Quick bug fix workflow
cp .agents/templates/task.md .ai-workspace/active/bugfix-001.md
# Edit the task, then:
# 1. Use Claude Code to analyze
# 2. Use Codex/Cursor to fix
# 3. Use Claude Code to review
```

### Code Review

1. **Load Context** (Claude Code): Read the PR diff and related files.
2. **Review** (Claude Code): Check logic, style, tests, and edge cases.
3. **Report**: Generate review report from template.

```bash
cp .agents/templates/review-report.md .ai-workspace/active/review-pr-42.md
# Use Claude Code to fill in the review
```

### Refactoring

1. **Analyze Scope** (Claude Code / Gemini CLI): Map all affected areas.
2. **Design** (Claude Code): Plan the refactoring approach.
3. **Implement** (Codex CLI / Cursor): Execute the refactoring.
4. **Verify** (Claude Code): Ensure no regressions, run tests.

```bash
cp .agents/templates/task.md .ai-workspace/active/refactor-001.md
# Follow the refactoring workflow in .agents/workflows/refactoring.yaml
```

## Creating Handoff Documents

When switching between AI tools, create a handoff document:

```bash
cp .agents/templates/handoff.md .ai-workspace/active/handoff-task-001-phase2.md
```

Fill in:
- What was completed
- Current state of the code
- What needs to happen next
- Any blockers or concerns

The receiving AI should read this document first to get up to speed.

## Best Practices

### 1. One AI Per Phase

Don't have multiple AIs working on the same files simultaneously. Follow the sequential workflow: analyze, design, implement, review, fix, commit.

### 2. Always Create Handoff Documents

Even if you're switching between AIs quickly, a brief handoff note saves time and prevents context loss.

### 3. Use the Right Tool for the Job

- Complex analysis? Use Claude Code or Gemini CLI.
- Straightforward implementation? Use Codex CLI or Cursor.
- Large file review? Use Gemini CLI.

### 4. Keep Tasks Small

Break large tasks into smaller, well-defined subtasks. Each subtask should be completable in a single AI session.

### 5. Version Control Your Progress

Commit frequently. Each phase completion is a good commit point. This makes it easy to roll back if needed.

### 6. Update Task Status

Always update the task's `status`, `current_step`, and `assigned_to` fields when transitioning between phases.

### 7. Review AI Output

Always review what an AI produces before committing. AI tools are assistants, not autonomous agents.
