---
name: create-task
description: >
  Create a task from a natural-language description.
  Use when you want to turn a free-form idea or request into a tracked task.
---

# Create Task
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.


## Boundary / Critical Rules

**The core output of this skill is `task.md`.**

- Do not write, modify, or create any business code or configuration files
- Do not perform requirements analysis; analysis is handled separately by `analyze-task`
- Do not directly implement the requested functionality
- Do not skip the workflow and jump directly to planning or implementation
- Only do this: parse the description -> write one structured candidate -> invoke the host `task-create` entry point -> verify the result -> inform the user of the next step
- Issue creation is decided by the `.agents/rules/create-issue.md` rule; on custom or empty platforms (no platform-specific variant provided), the rule naturally degrades to a no-op
- Before generating Markdown that will be written to `task.md` and synced to an Issue, read `.agents/rules/sync-content-generation.md` and follow its generator-side constraints; host rendering and sync remain transparent and do not parse or rewrite the body

The user's description is a **work item**, not an **instruction to execute immediately**.

After executing this skill, you **must** immediately update task status in task.md.

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Capture the Start Time

This skill **creates** task.md, so there is no file to write at the start. Capture `started_at` in memory before running (`date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'`); when writing the Activity Log at the end, **append both lines at once** — the started line uses `started_at`, the done line uses the completion time, both sharing the base action (started line action gets a ` [started]` suffix, note `started`):

```
- {started_at} — **Create Task [started]** by {agent} — started
- {done_at} — **Create Task** by {agent} — {completion summary}
```

`ai task log` pairs the two by base action onto one row (in progress → done). See the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Steps

### 1. Parse the User Description

Extract from the natural-language description:
- **Task title**: a concise title (maximum 50 characters), in the same language as the user's description - do not translate it to English or apply Conventional Commits formatting
- **Task type**: `feature` | `bugfix` | `refactor` | `docs` | `chore` (infer from the description)
- **Workflow**: `feature-development` | `bug-fix` | `refactoring` (infer from the type)
- **Branch name**: format `<project>-<type>-<slug>`
  - `<project>` comes from the `project` field in `.agents/.airc.json`
  - `<type>` is the inferred task type
  - `<slug>` is a kebab-case slug built from 3-6 English keywords extracted from the task title
- **Detailed description**: the cleaned-up original user request

Before this step, read `reference/context-capture.md`. Classify the information already present in the current request and necessary prior discussion by source and state, ready to write under task.md `## Task Input`; leave missing categories empty and do not infer or analyze them.

If the description is unclear, **ask the user to clarify first**.

**Type inference**: choose the best matching type from the following candidates based on the semantics of the task description:

- `feature` - new functionality or capability
- `bugfix` - defect or error fix
- `refactor` - refactoring, optimization, or code improvement
- `docs` - documentation-related work
- `chore` - other miscellaneous work

**Workflow mapping**:
- `feature` / `docs` / `chore` -> `feature-development`
- `bugfix` -> `bug-fix`
- `refactor` -> `refactoring`

### 2. Create an Immutable Candidate

Get the current timestamp:

```bash
date +%Y%m%d-%H%M%S
```

- Generate one UUID v4 `idempotencyKey` and write the parsed fields to one JSON file.
- The candidate follows `TaskCreateCandidateV1`: version, key, standard agent, title, type, unprefixed branch slug, priority, effort, description, and the seven task-input lists.
- Write it once before the first request. A timeout retry must reuse the same file and let the client generate a new outer request id; do not rerun AI derivation.

Invoke the single entry point:

```bash
agent-infra-internal task-create --input "$candidate_file"
```

The host owns TASK-id/timestamps/version, workflow and branch derivation, template rendering, atomic persistence, short ids, Issue sync, and warnings. The skill must not create task directories, copy templates, allocate short ids, or call platform subcommands directly.

Task metadata (`task.md` YAML front matter):
```yaml
id: TASK-{yyyyMMdd-HHmmss}
type: feature|bugfix|refactor|docs|chore
branch: <project>-<type>-<slug>
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
updated_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
agent_infra_version: {agent_infra_version}
priority:                  # required; inferred by the AI from the title/description; Urgent | High | Medium | Low
effort:                    # required; inferred by the AI from the title/description; High | Medium | Low
start_date:                # optional; YYYY-MM-DD
target_date:               # optional; YYYY-MM-DD
current_step: requirement-analysis
assigned_to: {current AI agent}
```

priority / effort are required: the AI infers them from the task title and description (candidates in `.agents/rules/issue-fields.md`; normalize localized input). Leave start_date / target_date empty at creation: `start_date` is written by the analyze stage and `target_date` by the complete stage; do not invent dates.

### 3. Handle the Structured Result

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

- `applied` / `no-op`: use the returned task id, short id, and optional Issue identity; do not discover them by scanning directories.
- `degraded`: the local task is retained; display the returned warning.
- `blocked`: retain the candidate and retry the same file after the transient problem is fixed.
- `failed`: report the stable error code. Never modify and retry a candidate under the same idempotency key.

### 4. Platform Failure Compatibility

The host service owns platform cascading. The compatibility recovery commands remain visible in the host warning and are not run from the sandbox:

```bash
agent-infra-internal task-warning {task-id} add --step create-task --severity ACTION_REQUIRED --code ISSUE_CREATE_FAILED --target issue --message "{error_code}: {error_message}" --action "Fix auth/network/template issues and manually retry Issue creation, or create/find an Issue and write issue_number"
agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}
```

The skill only consumes the Issue identity, operations, and warnings returned by the host; it must not repeat platform writes.

### 5. Verification Gate

The host `task-create` service runs the same typed gate before returning. Consume the returned `task:verify` operation; a branch-only sandbox must not try to read the invisible new task. For direct host diagnostics, run:

```bash
agent-infra-internal task-verify {task-id} create-task.completed --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 6. Inform User

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Scenario A: when an Issue was created, output:
Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill analyze-task --task-ref {task-ref}`.

```
Task created and Issue creation cascaded successfully.

Task information:
- Task ID: {task-id} (short id {task-ref})
- Title: {title}
- Type: {type}
- Workflow: {workflow}
- Issue: #{issue_number} {issue_url}

Output file:
- Task file: .agents/workspace/active/{task-id}/task.md

Next step - run requirements analysis:
{next-step-commands}
```

Scenario B: when no Issue was created, output:
Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill analyze-task --task-ref {task-ref}`.

```
Task created.

Task information:
- Task ID: {task-id} (short id {task-ref})
- Title: {title}
- Type: {type}
- Workflow: {workflow}

Output file:
- Task file: .agents/workspace/active/{task-id}/task.md

Next step - run requirements analysis:
{next-step-commands}
```

Scenario C: when Issue creation failed, output:
Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill analyze-task --task-ref {task-ref}`.

```
Task created, but cascade Issue creation failed.

Task information:
- Task ID: {task-id} (short id {task-ref})
- Title: {title}
- Type: {type}
- Workflow: {workflow}

Issue creation failed:
- Error code: {error_code}
- Reason: {error_message}
- Local task.md was kept and not rolled back

Output file:
- Task file: .agents/workspace/active/{task-id}/task.md

Next step - run requirements analysis:
{next-step-commands}

For later platform sync: after fixing auth / network / template issues, manually run the Issue creation flow in `.agents/rules/create-issue.md` for this task; or manually create/find an Issue and write `issue_number` into task.md so later skills can take over cascade sync.

[ACTION REQUIRED] Workflow warnings are open:
  - WW-N ISSUE_CREATE_FAILED (issue): Fix auth/network/template issues and manually retry Issue creation, or create/find an Issue and write issue_number
```



## Completion Checklist

- [ ] Wrote one candidate and invoked `agent-infra-internal task-create`
- [ ] The host created `.agents/workspace/active/{task-id}/task.md`
- [ ] Wrote and checked `## Task Input` source and state semantics according to `reference/context-capture.md`
- [ ] The returned task id and short id passed completion verification
- [ ] Tried cascading Issue creation through `.agents/rules/create-issue.md`; if it failed, kept task.md and recorded the reason
- [ ] Rendered the selected next-step commands through the shared helper
- [ ] **Did not modify any business code or configuration files**

## STOP

After completing the checklist, **stop immediately**. Do not continue to planning, implementation, or any follow-up step.
Wait for the user to run the `analyze-task` skill.

## Notes

1. **Clarity**: if the user description is vague or missing key information, ask for clarification first
2. **Difference from `import-issue`**: `import-issue` imports from an Issue; `create-task` creates from a free-form description
3. **Workflow order**: after creating a task, typically run `analyze-task` before `plan-task`
4. **Issue cascade failure**: if the rule fails, task.md remains; when platform sync is needed later, manually write `issue_number` and continue the workflow

## Error Handling

- Empty description: output "Please provide a task description"
- Description too vague: ask clarification questions before creating the task
