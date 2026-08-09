# Human Decision Context Contract

This rule governs every new `[needs-human-decision]` detail block produced by analyze, plan, code, and their three review workflows. Historical details do not need migration.

## Self-contained Context

A maintainer must be able to understand the issue and choose without knowing the internal workflow or asking a model to reconstruct context. Start in plain language: explain why a decision is needed now, what must be chosen, which choice is recommended, and why. Then explain what the choice affects and what could go wrong if the wrong choice is made or no action is taken.

Provide at least two options with short names, and state the benefits and trade-offs of each one. Explain internal terms such as stage, severity, and evidence the first time they appear. IDs and evidence are for lookup and troubleshooting; they do not replace the plain-language explanation.

## Canonical Structure

```markdown
### {AN-N|PL-N|CD-N|HD-N}: {Title} [needs-human-decision]

- **Why a decision is needed now**: {plain-language facts, constraints, and why work cannot simply continue}
- **What needs a decision**: {the one choice that must be made}
- **Recommended choice**: {Option A/B/...}
- **Why this choice**: {reason based on benefits, trade-offs, and current constraints}
- **What this affects**: {affected behavior, files, users, or future practice}
- **What could go wrong**: {problems caused by the wrong choice or no action}

#### Option A: {Name}

- **Benefits**: {what this option provides}
- **Trade-offs**: {what this option costs and where it falls short}

#### Option B: {Name}

- **Benefits**: {what this option provides}
- **Trade-offs**: {what this option costs and where it falls short}
```

Option C and supporting evidence may be added, but none of the information above may be omitted or collapsed into an incomparable one-line option list. The heading ID must match the task.md Review Disagreement Ledger row. Its evidence (the reference used to find the original explanation) must point to this stable heading anchor.

## Implementation Intent Declaration

For the code stage, the author must add `**Implementation required**: yes/no` after the options, then pass `--needs-implementation true|false` when `finding-review` escalates to `needs-human-decision` or when calling `decision-upsert`. The value is stored as a predeclared implementation input, so maintainers normally omit this option from `ai decide`. Historical tasks without a declaration may still pass it explicitly to `ai decide`; a value that conflicts with an existing declaration is rejected.

## Decision Closure

Use `ai task decisions <task-ref> <ordinal|ledger-id>` to inspect full context and `ai decide <task-ref> <ordinal|ledger-id> <decision>` to record the ruling. `ai decide` updates the row to `human-decided`, creates an independent `HDR-N` record, and updates evidence and the activity log; do not manually imitate only part of that transaction.
