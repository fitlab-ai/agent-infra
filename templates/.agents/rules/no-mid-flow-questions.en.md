# General Rule - No Mid-Flow Questions for Lifecycle Skills

> Applies only to lifecycle skills: `analyze-task` / `plan-task` / `implement-task` / `review-task` / `refine-task` (if they are renamed, update references according to the migration map from the refactoring task).
> Non-lifecycle skills (such as `create-task`, `commit`, `complete-task`, and `import-issue`) include user confirmation as part of their core purpose and are not governed by this rule.

## No-Mid-Flow-Questions Rule

Lifecycle skills must not ask the user questions during execution.

Specific constraints:

1. Do not call any user-question tool, including but not limited to `AskUserQuestion` and equivalent mechanisms that ask the user to choose.
2. When uncertain, proceed with the most robust option without interrupting the flow. Use this priority order:
   1. Prefer the option consistent with existing code, documentation, and rules
   2. Prefer the more reversible option
   3. Prefer the option with the smaller impact area
3. If assumptions or open questions exist, write them into fixed artifact sections instead of leaving them suspended in the conversation:
   - `## Assumptions`: assumptions used for this run that may be revisited later
   - `## Open Questions`: unresolved questions for human review

   If the artifact template does not reserve these sections, append them as needed. If there are no assumptions or open questions, do not force empty sections.
4. A short confirmation is allowed only before truly irreversible destructive operations, such as `git push --force` or `rm -rf` against the user's worktree. Routine design choices do not qualify.

## Human Review Checkpoint Semantics

A mandatory human review checkpoint means:

- Stop after producing the artifact: once the skill finishes an artifact such as `plan.md`, end the current invocation and wait for the user to explicitly trigger the next skill command
- Do not pause mid-process to ask for input: do not insert interruptions such as "Do you prefer option A or B?" between execution steps

If a key decision needs human judgment during execution, follow the assumptions and open questions rule above: record it in the artifact's *Open Questions* section for the user to address at the review checkpoint.

## Reference Format

Each lifecycle SKILL.md references this rule with a single line in its "Boundary / Critical Rules" section:

> No-mid-flow-questions rule: during execution, follow `.agents/rules/no-mid-flow-questions.md`; read it first.
