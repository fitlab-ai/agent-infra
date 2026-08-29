---
name: analyze-task
description: >
  Analyze a task and produce a requirements document.
  Use when you need to understand a task's requirements, scope, and risks before designing a solution.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Analyze Task
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

If the entry operands contain `--orchestrated`, bind `{execution-flag}` to `--orchestrated` and forward it unchanged to the completed event; otherwise bind it to an empty value. Never infer it from `orchestration.json`, environment variables, or prior artifacts.

## Boundary / Critical Rules

- This skill only outputs a requirements analysis document (`analysis.md` or `analysis-r{N}.md`) and does not modify any business code
- Base the analysis strictly on the existing task input, requirements, context, and source information in `task.md`
- When old behavior, data, schemas, or callers are involved, read `.agents/rules/compatibility-policy.md` first. State current-only when admission evidence is absent; do not turn speculation into a requirement
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

## Step Start: Declare the started Event

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} analyze.started --agent {standard-agent-token}` and verify the returned `artifactContext`.

## Steps

### 1. Verify Prerequisites

Check required files:
- `.agents/workspace/active/{task-id}/task.md` - Task file

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If `task.md` is missing, tell the user to create or import the task first.

### 2. Resolve the Analysis Context

Run `agent-infra-internal task-artifact {task-id} inspect --family analysis`. Continue only for `ready`; take `{analysis-round}` / `{analysis-artifact}` from `next.round` / `next.name` and revision inputs from `inputs`. Do not scan rounds or construct names in the skill.

### 3. Read Task Context

Read `task.md` carefully to understand:
- sources, facts and evidence, constraints, decision states, acceptance criteria, and open questions captured under `## Task Input` (fall back compatibly when the section is absent)
- task title, description, and requirement list
- context information (Issue, PR, branch, alert numbers, etc.)
- currently known affected files and constraints

If `task.md` contains these source fields, also read the corresponding source information:
- `issue_number` - Issue
- `codescan_alert_number` - Code Scanning alert
- `security_alert_number` - Dependabot alert

**Round ≥ 2: respond to the prior review (only when a review artifact exists)**: if the task directory contains `review-analysis.md` / `review-analysis-r{N}.md`, read the highest-round review report; add a `## Response to Prior Review` section to this round's analysis artifact, and for each finding verify it via Read/Grep, then dispose of it with one of the four states in `.agents/rules/review-handshake.md` (`accepted` / `adjusted` / `refuted` / `cannot-judge`) with commensurate evidence. Submit each response through `agent-infra-internal task-ledger {task-id} finding-respond --id {ledger-id} --round {analysis-round} --status {state} --evidence {evidence}`. Record open disagreements under `## Open Questions`. Round 1 skips this section.

### 4. Requirement Sufficiency Gate

> Questions in this step are authorized by `.agents/rules/no-mid-flow-questions.md` "Exemption 3: Entry-point requirement-sufficiency clarification": only at the analyze-task entry point, only to judge and fill requirement sufficiency, one question at a time, and **never** to solicit implementation / technical-choice preferences.

Runs after Step 0 state check and Step 3 (questioning is an external-state action and must come after the state-check hard gate; the judgment and state read/write need task.md first).

**4.1 Read cross-round state**: read the `## Brainstorming` section of task.md (treat as first time when absent, `question_count=0`). Section format:

```
## Brainstorming
- status: asking | done
- question_count: <int>
- pending_question: <text, may be empty>
- answered:
  - Q: … / A: …
```

**4.2 Receive the answer to the previous question**: if `pending_question` exists:
- the user's current message yields an answer → write the answer back into `## Description` / `## Requirements`, append that `Q/A` to `answered`, and clear `pending_question` (`question_count` unchanged).
- no answer carried → restate `pending_question` and take Scenario B early-exit below (do not increase `question_count`).

**4.3 Sufficiency judgment** (objective checklist; any gap hit means insufficient):
- first aggregate `## Task Input`, description, context, requirements, and remote sources; an analysis-owned `## Requirements` section being unpopulated is not by itself insufficient;
- goals, scope, constraints, or acceptance criteria already recorded in task input count as provided and must not be asked again;
- description/requirements empty, or a single sentence with no verifiable acceptance criteria;
- missing goal or impact scope (unclear what to change / who is affected);
- requirement items contradict each other, or key terms are undefined and block analysis.

**4.4 Branch**:

- **Scenario A (sufficient / converged)** — any exit condition met: the checklist fully passes / the user explicitly says "just analyze / skip" / `question_count` reaches the cap (≤5). Set `## Brainstorming` `status: done` and continue the normal flow from step 5; write any remaining gaps into the analysis artifact `## Assumptions` / `## Open Questions`.
- **Scenario B (insufficient, ask and early-exit)** — close the loop within this step and STOP early:
  1. Decide this round's question (consistent with 4.2):
     - if a `pending_question` already exists (the previous question is still unanswered) → restate that `pending_question`, do **not** modify it and do **not** increment `question_count`;
     - otherwise (no pending question) → pick the single highest-value question (acceptance criteria > scope > ambiguity) and write `## Brainstorming`: `status: asking`, `pending_question: <question>`, `question_count += 1`.
  2. If `start_date` is empty, write today (`date +%F`), then run `agent-infra-internal task-event {task-id} analyze.awaiting-input --agent {standard-agent-token} --question {question_count}` so the core updates base metadata and Activity Log.
  3. Issue sync (when `issue_number` exists, skip on any failure): run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}` to update only the **task comment**; keep the `status` label at `pending-design-work`; do **not** publish an analysis artifact comment.
  4. Verification (replaces the step 8 artifact gate): `agent-infra-internal task-verify {task-id} analyze.awaiting-input --format text` (the early-exit set `current_step: requirement-analysis` and wrote `start_date`, so it should pass); also keep `rg -n 'Analyze Task \(Brainstorming\)' .agents/workspace/active/{task-id}/task.md` and the task-comment sync evidence. Do **not** run the artifact gate, nor `check activity-log` / `check platform-sync` (both bind to the analysis artifact path).
  5. User output: show only the current **single question** plus how to answer/continue (re-trigger `analyze-task {task-ref}` with the answer), and append the `Completed at` line per `.agents/rules/next-step-output.md`.
  6. **STOP** and wait for the answer. The next trigger returns to this step.

### 5. Perform Requirements Analysis

Before analysis begins: if `start_date` in the frontmatter is empty, write today's date immediately (command: `date +%F`, format `YYYY-MM-DD`); keep any existing value. Before writing, read `.agents/rules/version-stamp.md` and refresh `updated_at` / `agent_infra_version` at the same time.

Follow the `analysis` step in `.agents/workflows/feature-development.yaml`:

**Required tasks** (analysis only, no business code changes):
- [ ] Understand the task requirements and goals
- [ ] Search related code files (**read-only**)
- [ ] Analyze code structure and impact scope
- [ ] Identify potential technical risks and dependencies
- [ ] Assess effort and complexity

### 6. Output Analysis Document

> Steps 6–9 are the **Scenario A (normal output)** path. **Scenario B (ask and early-exit)** already finished its state update, task-comment sync, and verification inside step 4 and STOPped, so it does not enter these steps.

Create `.agents/workspace/active/{task-id}/{analysis-artifact}`.

## Output Template

```markdown
# Requirements Analysis Report

- **Analysis round**: Round {analysis-round}
- **Artifact file**: `{analysis-artifact}`

## State Check

> Paste the raw Step 0 state-check command output; each command starts with `$ `.

## Requirement Source

**Source type**: {User description / Issue / Code Scanning / Dependabot / Other}
**Source summary**:
> {Task source or key context}

## Requirement Understanding
{Restate the requirement in your own words to confirm understanding}

## Related Files
- `{file-path}:{line-number}` - {Description}

## Impact Assessment
**Direct impact**:
- {Affected modules and files}

**Indirect impact**:
- {Other parts that may be affected}

## Technical Risks
- {Risk description and mitigation idea}

## Dependencies
- {Required dependencies and coordination with other modules}

## Assumptions

> If this analysis depends on assumptions, list them here; omit this section if there are none.

- {assumption}

## Open Questions

> If there are unresolved questions for human review, list them here; omit this section if there are none.
> Ordinary open questions go here; for key design decisions (per `.agents/rules/no-mid-flow-questions.md`), put the detail block under `## 人工裁决待办` (Pending Human Decisions) as `### HD-N` instead, and keep only a one-line pointer here.

- {open question}

## 人工裁决待办

> Write this section only when this round upgraded a `[needs-human-decision]` key design decision; omit otherwise.
> First run `agent-infra-internal task-ledger {task-id} decision-next-id` to obtain `HD-N`, write the self-contained block according to `.agents/rules/human-decision-context.md`, then run `decision-upsert --id {HD-N} --stage analysis --artifact {analysis-artifact}`. Do not scan ids or assemble ledger rows.

## Effort and Complexity Assessment
- Complexity: {High/Medium/Low}
- Risk level: {High/Medium/Low}
```

### 7. Update Task Status

Update `.agents/workspace/active/{task-id}/task.md`:
- Record the analysis artifact for this round: `{analysis-artifact}` (Round `{analysis-round}`)
- If the task template contains a `## Analysis` section, update it to link to `{analysis-artifact}`
- Mark requirement-analysis as complete in workflow progress and include the actual round when the task template supports it
- Before appending the workflow Activity Log entry, re-estimate `priority` based on the analysis findings (business impact, risks, dependencies, blockers). If the re-estimated value differs from the current value in `task.md`:
  - Overwrite the `priority` field in frontmatter with the new value
  - Append a `## Priority Re-estimate` section to this round's analysis artifact `{analysis-artifact}`, recording: `priority {old} → {new} (rationale: {short basis grounded in this analysis})`
  If the re-estimated value matches the current value, skip it: do not write the `## Priority Re-estimate` section. The Flow A sync that follows reads the possibly updated frontmatter and propagates the new value to the Issue automatically.
After the business fields are updated, run `agent-infra-internal task-event {task-id} analyze.completed --agent {standard-agent-token} --artifact {analysis-artifact} {execution-flag}` so the core atomically records the link, stage, agent, metadata, and Activity Log.
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Analyze Task (Round {N})** by {agent} — Analysis completed → {analysis-artifact}
  ```

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status pending-design-work --fields`
- Run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- Run `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {analysis-artifact} --agent {standard-agent-token}`

### 8. Verification Gate

> This artifact gate is for **Scenario A** only; Scenario B's verification is in step 4 (`check task-meta` + explicit evidence), not the artifact gate here.

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
agent-infra-internal task-verify {task-id} analyze.completed --artifact {analysis-artifact} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 9. Inform User

> This step is the **Scenario A** normal-completion output; Scenario B's single-question output is in step 4.

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Output format:
Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill review-analysis --task-ref {task-ref}`.

```
Analysis complete for task {task-id}.

Summary:
- Analysis round: Round {analysis-round}
- Related files: {count}
- Risk level: {assessment}

Output file:
- Analysis report: .agents/workspace/active/{task-id}/{analysis-artifact}

Next step - review the analysis:
{next-step-commands}
```

## Completion Checklist

- [ ] Read and understood the task file and source information
- [ ] Created analysis document `.agents/workspace/active/{task-id}/{analysis-artifact}`
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Updated `assigned_to` in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Marked requirement-analysis as complete in workflow progress
- [ ] Rendered the selected next-step commands through the shared helper
- [ ] **Did not modify any business code**

## STOP

After completing the checklist, **stop immediately**. Wait for the user to review the analysis result and manually invoke the `plan-task` skill.

## Notes

1. **Prerequisite**: the task file `task.md` must already exist
2. **Multi-round analysis**: use `analysis-r{N}.md` when requirements change or an existing analysis needs revision
3. **Single responsibility**: this skill only handles analysis, not planning or implementation

## Error Handling

- Task not found: output "Task {task-id} not found, please check the task ID"
