# Context Capture Protocol

## Scope

Capture only the current natural-language request and the necessary prior discussion that is visible in the current context and directly relevant to the task. Do not read outside the available context, preserve a full transcript, perform requirements analysis, analyze code impact, or design a solution.

## Classification

Faithfully condense existing information into task.md under `## Task Input`:

- `### Sources`: identify the current user request, an earlier user statement, user confirmation, or an agent suggestion.
- `### Confirmed Facts and Evidence`: include only user-provided or verified facts, reproduction steps, errors, and observations.
- `### Constraints`: preserve explicit user limits, security boundaries, and compatibility requirements.
- `### Confirmed Decisions`: include only directions explicitly confirmed by the user; never promote an agent suggestion to an approved decision.
- `### Candidate and Rejected Options`: label each item as a candidate, agent suggestion, tentative assumption, or rejected option and preserve its source.
- `### Acceptance Criteria`: retain user-provided observable inputs, actions, and expected results.
- `### Open Questions`: retain unanswered questions and choices that still require a decision.

Leave missing categories empty rather than inferring content. Deduplicate repeated information without losing its source or state.

## Observable Acceptance Extraction

The following language-neutral contract is the stable boundary for capturing observable acceptance information:

```text
# observable-acceptance-contract
sources: current-request,necessary-prior-discussion
scan-entire-visible-context: true
recognize-without-acceptance-label: true
components: observable-input,action,expected-result
combine-distributed-evidence: true
preserve-source-state: true
missing-components: preserve-as-gaps
agent-inference-as-confirmed: false
destination: task-input.acceptance-criteria
scenario-explicit: capture-supported-components
scenario-distributed: combine-supported-components
scenario-insufficient: preserve-supported-components-and-gaps
```

Execution order:

1. Scan the complete visible context of the current request and necessary prior discussion. Recognize observable information even when the user did not label it as acceptance criteria.
2. Identify observable inputs, user or system actions, and expected results. These components may be distributed across turns.
3. Combine supported components that describe the same behavior into a self-contained item, preserving the source and confirmation state of each piece of information.
4. Preserve unexpressed components as gaps. Do not invent thresholds, scenarios, actions, or results, and do not mark agent inference as user-confirmed information.
5. Write the items under `## Task Input / ### Acceptance Criteria`. If the context provides no observable criterion, leave that category empty and retain genuine unknowns in the existing categories.

Boundary examples:

- **Single-turn explicit information**: when the current request provides an input, action, and result, capture every supported component and identify the current request as its source.
- **Distributed information**: when the current request describes an action and necessary prior discussion provides an input or result, combine only components for the same behavior and preserve their source states separately.
- **Insufficient information**: when the user only says that something "should be faster" without an observable condition or threshold, do not invent a performance target; preserve the stated concern and gaps, leaving the acceptance category empty when no criterion can be formed.

## Safety and Compression

- Exclude secrets, tokens, credentials, and unrelated personal information.
- Write a self-contained summary instead of copying the full transcript.
- Preserve commands, error text, paths, or identifiers only when necessary for reproduction or acceptance.

## Completion Check

A reader with only the generated task.md must be able to distinguish confirmed information, candidates or assumptions, rejected content, and open questions, and understand the task goal and existing acceptance criteria.
