# Prebuilt Workflows

[← Back to README](../../README.md) · [中文](../zh-CN/workflows.md)

agent-infra includes **4 prebuilt workflows**. Three of them share the same symmetric gated delivery lifecycle:

`analysis -> analysis-review -> design -> design-review -> code (local checkpoint) -> code-review -> delivery -> complete`

The fourth, `code-review`, is intentionally smaller and optimized for reviewing an existing PR or branch.

| Workflow | Best for | Step chain |
|----------|----------|------------|
| `feature-development` | Building a new feature or capability | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> delivery -> complete` |
| `bug-fix` | Diagnosing and fixing a defect with regression coverage | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> delivery -> complete` |
| `refactoring` | Structural changes that should preserve behavior | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> delivery -> complete` |
| `code-review` | Reviewing an existing PR or branch | `analysis -> review -> report` |

## Example lifecycle

The simplest end-to-end delivery loop looks like this:

```text
import-issue #42                    Import task from GitHub Issue
(or: create-task "add dark mode")   Or create a task from a description; Issue creation cascades when the platform rule supports it
         |
         |  --> get task ID, e.g. T1
         v
  analyze-task T1                   Requirement analysis
         |
         v
  review-analysis T1                Review analysis
         |
     Issues?
      +--YES----> analyze-task T1
      |
         v
    plan-task T1                    Design solution
         |
         v
  review-plan T1                    Review plan
         |
     Issues?
      +--YES----> plan-task T1
      |
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

`code-task` creates the local checkpoint that `review-code` examines. Task preparation persists the delivery remote and base branch; `create-pr` reuses that binding, validates the reviewed head, and is the only task-path operation that pushes the branch.
