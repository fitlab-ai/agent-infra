# Prebuilt Workflows

[← Back to README](../../README.md) · [中文](../zh-CN/workflows.md)

agent-infra includes **4 prebuilt workflows**. Feature development, bug fixes, and refactoring all start with analysis. The analysis records one canonical path from observable task facts:

| Path | Stage chain | Selection rule |
|------|-------------|----------------|
| Streamlined | `analysis -> code (local checkpoint) -> code-review` | Scope and acceptance are clear; no separate design or document-audit decision is required |
| Standard | `analysis -> design -> code (local checkpoint) -> code-review` | The implementation needs an explicit cross-module contract, data flow, or test strategy |
| Full | `analysis -> analysis-review -> design -> design-review -> code (local checkpoint) -> code-review` | Concrete acceptance disputes, costly interface/schema/migration decisions, or real external/security boundaries require independent review |

All three paths retain independent code review. File count, module count, or a possible risk cannot select the full path by itself. A later finding can route work back to analysis, design, code, a human decision, or an evidence-insufficient pause. The fourth workflow, `code-review`, remains optimized for reviewing an existing PR or branch.

| Workflow | Best for | Step chain |
|----------|----------|------------|
| `feature-development` | Building a new feature or capability | Analysis selects the streamlined, standard, or full path; then delivery and completion follow |
| `bug-fix` | Diagnosing and fixing a defect with regression coverage | Analysis selects the streamlined, standard, or full path; then delivery and completion follow |
| `refactoring` | Structural changes that should preserve behavior | Analysis selects the streamlined, standard, or full path; then delivery and completion follow |
| `code-review` | Reviewing an existing PR or branch | `analysis -> review -> report` |

## Example lifecycle

This example follows the **standard path**. A streamlined task skips design; a full-path task adds analysis review and design review at their respective checkpoints.

```text
import-issue #42                    Import task from GitHub Issue
(or: create-task "add dark mode")   Or create a task from a description; Issue creation cascades when the platform rule supports it
         |
         |  --> get task ID, e.g. T1
         v
  analyze-task T1                   Requirement analysis
         |
         v
  plan-task T1                      Design solution
         |
         v
  code-task T1                      Write code, tests, and a local checkpoint
         |
         v
  +-> review-code T1                Automated code review
  |      |
  |   Issues?
  |      +--NO-------+
  |     YES          |
  |      |           |
  |      v           |
  |  code-task T1 (fix mode)
  |      |           |
  +------+           |
                     |
         +-----------+
         |
         v
   create-pr T1                     Publish the approved checkpoint to the task-bound target
         |
         v
  complete-task T1                  Archive after merge and final gates
```

`code-task` creates the local checkpoint that `review-code` examines on every path. Task preparation persists the delivery remote and base branch; `create-pr` reuses that binding, validates the reviewed head, and is the only task-path operation that pushes the branch.
