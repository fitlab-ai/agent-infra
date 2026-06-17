# Prebuilt Workflows

[← Back to README](../../README.md) · [中文](../zh-CN/workflows.md)

agent-infra includes **4 prebuilt workflows**. Three of them share the same symmetric gated delivery lifecycle:

`analysis -> analysis-review -> design -> design-review -> code -> code-review -> commit`

The fourth, `code-review`, is intentionally smaller and optimized for reviewing an existing PR or branch.

| Workflow | Best for | Step chain |
|----------|----------|------------|
| `feature-development` | Building a new feature or capability | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> commit` |
| `bug-fix` | Diagnosing and fixing a defect with regression coverage | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> commit` |
| `refactoring` | Structural changes that should preserve behavior | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> commit` |
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
  code-task T1                      Write code and tests
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
      commit                        Commit final code
         |
         v
  complete-task T1                  Archive and finish
```
