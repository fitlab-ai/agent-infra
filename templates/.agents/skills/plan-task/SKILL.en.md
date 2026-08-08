---
name: plan-task
description: >
  Design a technical plan for a task.
  Use when a requirement is understood and you need a technical design before coding.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Design Technical Plan
> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`antigravity`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `antigravity-cli`->`antigravity`), or the `human` manual exception.

If the entry operands contain `--orchestrated`, bind `{execution-flag}` to `--orchestrated` and forward it unchanged to the completed event; otherwise bind it to an empty value. Never infer it from `orchestration.json`, environment variables, or prior artifacts.

## Boundary / Critical Rules

- This skill only outputs a technical plan document (`plan.md` or `plan-r{N}.md`) and does not modify any business code
- This is a **mandatory human review checkpoint**; do not automatically proceed to implementation
- After executing this skill, you **must** immediately update task status in task.md

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and paste the raw output into both the user-facing reply and this round's `## State Check` section:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

Before the state check is complete, do not make external-state assertions such as "the code is unchanged", "tests passed", or "there are no other references", including in reasoning. This gate is only a structural floor; evidence pairing and authenticity still require the report template and review discipline.

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} plan.started --agent {standard-agent-token}` and verify the returned `artifactContext`.

## Steps

### 1. Verify Prerequisites

Check required files:
- `.agents/workspace/active/{task-id}/task.md` - Task file
- At least one analysis artifact: `analysis.md` or `analysis-r{N}.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If any required file is missing, prompt the user to complete the prerequisite step first.

### 2. Resolve the Artifact Context

Run `agent-infra-internal task-artifact {task-id} inspect --family plan`. Continue only for `ready`; take the latest `{analysis-artifact}` from `inputs` and `{plan-round}` / `{plan-artifact}` from `next.round` / `next.name`. Do not scan rounds or construct names in the skill. Then run the started event and verify the returned identity.

### 3. Read Requirements Analysis

Scan the task directory for analysis artifact files (`analysis.md`, `analysis-r{N}.md`):
- If any `analysis-r{N}.md` exists, read the highest N file
- otherwise read `analysis.md`
Use it to understand:
- the requirements and background
- related files and code structure
- impact scope and dependencies
- identified technical risks
- effort and complexity assessment

**Round ≥ 2: respond to the prior review (only when a review artifact exists)**: if the task directory contains `review-plan.md` / `review-plan-r{N}.md`, read the highest-round review report; add a `## Response to Prior Review` section and verify every finding before choosing `accepted` / `adjusted` / `refuted` / `cannot-judge`. Submit each response through `agent-infra-internal task-ledger {task-id} finding-respond --id {ledger-id} --round {plan-round} --status {state} --evidence {evidence}`. Record open disagreements under `## Open Questions`. Round 1 skips this section.

### 4. Understand the Problem

- Read the relevant source files identified in the analysis
- Understand the current architecture and patterns
- Identify constraints (backward compatibility, performance, etc.)
- Consider edge cases and failure scenarios

### 5. Design the Technical Plan

Follow the `technical-design` step in `.agents/workflows/feature-development.yaml`:

**Required tasks**:
- [ ] Define the technical approach and rationale
- [ ] Consider alternatives and explain the tradeoffs
- [ ] List implementation steps in detailed order
- [ ] List all files that need to be created or modified
- [ ] Define the verification strategy (tests, manual checks)
- [ ] Assess impact and risks

When this round introduces a new key design decision, first run `agent-infra-internal task-ledger {task-id} decision-next-id`, write the returned `HD-N` as a self-contained block under `## 人工裁决待办` (Pending Human Decisions) according to `.agents/rules/human-decision-context.md`, then run `decision-upsert --id {HD-N} --stage plan --artifact {plan-artifact}`. Ordinary open questions still go under `## Open Questions`.

**Design principles**:
1. **Architectural soundness**: choose the structurally correct approach; diff size is not the primary criterion. Do not pile changes onto an unsound structure just to keep the diff small
2. **Simplicity**: given a sound architecture, prefer the simplest approach and avoid over-engineering
3. **Consistency**: follow existing code patterns and conventions
4. **Testability**: design for straightforward testing
5. **Reversibility**: prefer changes that are easy to roll back

### 6. Output Plan Document

Create `.agents/workspace/active/{task-id}/{plan-artifact}`.

### 7. Update Task Status

Update `.agents/workspace/active/{task-id}/task.md`:
- Record the plan artifact for this round: `{plan-artifact}` (Round `{plan-round}`)
- If the task template contains a `## Design` section, update it to link to `{plan-artifact}`
- Mark technical-design as complete in workflow progress and include the actual round when the task template supports it
- Before appending the workflow Activity Log entry, re-estimate `effort` based on the technical plan (number of implementation steps, files touched, test matrix scope, integration surface). If the re-estimated value differs from the current value in `task.md`:
  - Overwrite the `effort` field in frontmatter with the new value
  - Append a `## Effort Re-estimate` section to this round's plan artifact `{plan-artifact}`, recording: `effort {old} → {new} (rationale: {short basis grounded in this plan})`
  If the re-estimated value matches the current value, skip it: do not write the `## Effort Re-estimate` section. The Flow A sync that follows reads the possibly updated frontmatter and propagates the new value to the Issue automatically.
After the business fields are updated, run `agent-infra-internal task-event {task-id} plan.completed --agent {standard-agent-token} --artifact {plan-artifact} {execution-flag}` so the core atomically records the link, stage, agent, metadata, and Activity Log.
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Plan Task (Round {N})** by {agent} — Plan completed, awaiting human review → {artifact-filename}
  ```

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status pending-design-work --fields`
- Run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- Run `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {plan-artifact} --agent {standard-agent-token}`

### 8. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
agent-infra-internal task-verify {task-id} plan.completed --artifact {plan-artifact} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 9. Inform User

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Output format:
Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill review-plan --task-ref {task-ref}`.

```
Technical plan complete for task {task-id}.

Plan summary:
- Round: Round {plan-round}
- Approach: {brief description}
- Files to modify: {count}
- Files to create: {count}
- Estimated complexity: {assessment}

Output file:
- Technical plan: .agents/workspace/active/{task-id}/{plan-artifact}

Important: human review checkpoint.
Please review the technical plan before continuing to implementation.

Next step - review the technical plan:
{next-step-commands}
```

## Completion Checklist

- [ ] Read and understood the requirements analysis
- [ ] Considered alternative options
- [ ] Created the plan document `.agents/workspace/active/{task-id}/{plan-artifact}`
- [ ] Updated `current_step` to technical-design in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Recorded `{plan-artifact}` as a completed artifact in task.md
- [ ] Marked technical-design as complete in workflow progress
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user that this is a human review checkpoint
- [ ] Rendered the selected next-step commands through the shared helper

## STOP

After completing the checklist, **stop immediately**.
This is a **mandatory human review checkpoint**; the user must review and approve the plan before implementation can continue.

## Notes

1. **Prerequisite**: at least one round of requirements analysis must already be complete (`analysis.md` or `analysis-r{N}.md` exists)
2. **Human review**: this is a mandatory checkpoint; do not automatically proceed to implementation
3. **Plan quality**: the plan should be detailed enough that another AI agent can implement it without extra context
4. **Versioning rule**: the first plan uses `plan.md`; later revisions use `plan-r{N}.md`

## Error Handling

- Task not found: output "Task {task-id} not found, please check the task ID"
- Analysis missing: output "Analysis not found, please run the analyze-task skill first"
