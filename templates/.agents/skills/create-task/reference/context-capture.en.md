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

## Safety and Compression

- Exclude secrets, tokens, credentials, and unrelated personal information.
- Write a self-contained summary instead of copying the full transcript.
- Preserve commands, error text, paths, or identifiers only when necessary for reproduction or acceptance.

## Completion Check

A reader with only the generated task.md must be able to distinguish confirmed information, candidates or assumptions, rejected content, and open questions, and understand the task goal and existing acceptance criteria.
