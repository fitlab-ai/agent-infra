# General Rule - No Mid-Flow Questions During SKILL Execution

> **Scope**: this rule applies to **all SKILL** executions.
> Only the exemption categories listed below may ask the user; any other mid-flow question is a violation.

## Exemption Categories

### Exemption 1: Literal clarification of entry-point natural-language input

Allowed only when the SKILL's core responsibility is to process **natural-language input the user provided in this invocation**, and that input is unparseable or self-contradictory. The clarification must be about the **literal input itself**; it must not be used to solicit implementation preferences.

SKILLs currently covered by this exemption:

- `create-task`: may clarify the task description itself when the user-provided description is unclear
- `refine-title`: requires the user's final confirmation (y/n) for a generated title

### Exemption 2: Short confirmation before truly irreversible destructive operations

Any SKILL may pause briefly before the following irreversible operations; routine design choices do not qualify:

- `git push --force`, `rm -rf` against the user's worktree, etc.
- Deleting or overwriting shared remote resources (e.g., shared GitHub labels)
- Overwriting uncommitted local changes

SKILLs currently covered by this exemption:

- `init-labels`: may confirm before deleting legacy labels not in the final mapping
- `commit`: may stop and confirm when its plan conflicts with the user's uncommitted changes

### Exemption 3: Entry-point requirement-sufficiency clarification

Allowed only when a SKILL judges, **at its entry point**, whether the current task's requirement information is sufficient for a reliable analysis; it may then ask the user about the **missing requirement information** to converge the requirements. Constraints:

- Limited to the `analyze-task` entry point; ask one question at a time and wait for the answer before asking the next;
- Used only to fill requirement-sufficiency gaps; it must **not** be used to solicit implementation / technical-choice preferences (those still go into the artifact's `## Open Questions` per the default clause);
- Exit the questioning and proceed to normal analysis once the question budget is reached or the user says "just analyze / skip".

SKILLs currently covered by this exemption:

- `analyze-task`: when the task description/requirements are insufficient for a reliable analysis, it may ask questions one at a time at the entry point to converge the requirements

## No-Mid-Flow-Questions Clause (default behavior)

For every SKILL execution context not covered by any exemption above, the default behavior is:

1. Do not call any user-question tool, including but not limited to `AskUserQuestion` and equivalent mechanisms that ask the user to choose.
2. When uncertain, proceed with the most robust option without interrupting the flow. Use this priority order:
   1. Prefer the option consistent with existing code, documentation, and rules
   2. Prefer the more reversible option
   3. Prefer the option with the smaller impact area
3. If assumptions or open questions exist, write them into fixed artifact sections instead of leaving them suspended in the conversation:
   - English artifacts use `## Assumptions` / `## Open Questions`; Chinese artifacts use `## 假设` / `## 未决问题`
   - Meaning: the assumptions section records assumptions used for this run that may be revisited later; the open questions section records unresolved questions for human review
   - If the artifact template does not reserve these sections, append them as needed. If there are no assumptions or open questions, do not force empty sections.

## Key Design Decision Marking And Ledgering

When an open question is a key design decision that needs human judgment, the executor must mark the item with `[needs-human-decision]` and write the matching `HD-` row to task.md `## Review Disagreement Ledger` according to `.agents/rules/review-handshake.md`.

Use these checks together:

- **Source test**: can the conclusion be uniquely derived from the task description, existing requirements, code conventions, or an approved plan? If not, and multiple reasonable options exist, it is a choice.
- **Impact test**: does the choice change scope, boundaries, defaults, thresholds, become irreversible / costly, or set precedent for later tasks? Any hit upgrades it to a key design decision.
- **Small-impact exemption**: if it is only a local, reversible, low-cost execution detail, record it under `## Assumptions` instead of upgrading it to a human ruling.
- **Fallback**: when unsure whether it is key, treat it as key; `review-*` must check whether the executor missed any `[needs-human-decision]` markings that should have been upgraded.

## Human Review Checkpoint Semantics

A mandatory human review checkpoint means:

- Stop after producing the artifact: once the skill finishes an artifact such as `plan.md`, end the current invocation and wait for the user to explicitly trigger the next skill command
- Do not pause mid-process to ask for input: do not insert interruptions such as "Do you prefer option A or B?" between execution steps

If a key decision needs human judgment during execution, follow the assumptions and open questions rule above: record it in the artifact's "Open Questions" / `未决问题` section for the user to address at the review checkpoint.

## Anchor Location

This rule's sole global anchor lives in the project-level AGENTS.md "AI Behavior Principles" preamble, which every AI tool loads. Individual SKILL.md files no longer reference this rule, so no per-skill duplicate bullet needs to be maintained.

When executing any SKILL, if AGENTS.md's preamble notes "follow this rule first," the LLM should **proactively Read** this file to load the complete exemption list and concrete constraints.
