# Human Decision Context Contract

This rule governs every new `[needs-human-decision]` detail block produced by analyze, plan, code, and their three review workflows. Historical details do not need migration.

## Self-contained Context

A maintainer must be able to decide without asking a model to reconstruct context. Every item must state its background, decision objective, impact scope, risks, recommended option, and recommendation rationale. It must provide at least two options, each with both benefits and costs.

## Canonical Structure

```markdown
### {AN-N|PL-N|CD-N|HD-N}: {Title} [needs-human-decision]

- **Background**: {facts, constraints, and why a decision is needed}
- **Decision Objective**: {the single choice that must be made}
- **Impact Scope**: {affected behavior, files, users, or precedent}
- **Risks**: {risks of the wrong choice, delay, or no decision}
- **Recommended Option**: {Option A/B/...}
- **Recommendation Rationale**: {reason based on benefits, costs, and constraints}

#### Option A: {Name}

- **Benefits**: {benefits of this option}
- **Costs**: {costs and limitations of this option}

#### Option B: {Name}

- **Benefits**: {benefits of this option}
- **Costs**: {costs and limitations of this option}
```

Option C and supporting evidence may be added, but none of the fields above may be omitted or collapsed into an incomparable one-line option list. The heading ID must match the task.md Review Disagreement Ledger row, whose evidence must point to this stable heading anchor.

## Decision Closure

Use `ai task decisions <task-ref> <ordinal|ledger-id>` to inspect full context and `ai decide <task-ref> <ordinal|ledger-id> <decision>` to record the ruling. `ai decide` updates the row to `human-decided`, creates an independent `HDR-N` record, and updates evidence and the activity log; do not manually imitate only part of that transaction.
