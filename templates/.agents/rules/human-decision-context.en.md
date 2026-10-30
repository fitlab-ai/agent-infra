# Human Decision Context Contract

This rule governs every new `[needs-human-decision]` detail block produced by analyze, plan, code, and their three review workflows. Historical details do not need migration.

## Self-contained Context

A maintainer must be able to understand the issue and choose without knowing the internal workflow or asking a model to reconstruct context. In a fixed order, explain in plain language what must be chosen, why a decision is needed now, what it affects, and what could go wrong if it is wrong or postponed. Then explain each option, followed by the recommendation and its reason.

Provide at least two options with short names. For each option, explain what would actually be done, what would happen after choosing it, its benefits, and its trade-offs. Each decision must also include at least one everyday example or analogy that stays true to the real effects and helps the maintainer compare the options. Explain internal terms such as stage, severity, and evidence the first time they appear. IDs and evidence are for lookup and troubleshooting; they do not replace the plain-language explanation.

## Canonical Structure

```markdown
### {AN-N|PL-N|CD-N|HD-N}: {Title} [needs-human-decision]

- **What needs a decision**: {the one choice that must be made}
- **Why a decision is needed now**: {plain-language facts, constraints, and why work cannot simply continue}
- **What this affects**: {affected behavior, files, users, or future practice}
- **What could go wrong**: {problems caused by the wrong choice or no action}

#### Option A: {Name}

- **What would actually be done**: {how the system or follow-up work would handle this option}
- **What happens after choosing it**: {specific changes for users, behavior, or follow-up work}
- **Benefits**: {what this option provides}
- **Trade-offs**: {what this option costs and where it falls short}
- **Example or analogy**: {a plain-language example that shows this option's real effect}

#### Option B: {Name}

- **What would actually be done**: {how the system or follow-up work would handle this option}
- **What happens after choosing it**: {specific changes for users, behavior, or follow-up work}
- **Benefits**: {what this option provides}
- **Trade-offs**: {what this option costs and where it falls short}
- **Example or analogy**: {a plain-language example that shows this option's real effect}

- **Recommended choice**: {Option A/B/...}
- **Why this choice**: {reason based on benefits, trade-offs, and current constraints}
```

Option C and supporting evidence may be added, but none of the information above may be omitted or collapsed into an incomparable one-line option list. Every option needs its own example or analogy, and it does not replace facts, concrete effects, or risks. Put the recommendation and its reason after all options. The heading ID must match the task.md Review Disagreement Ledger row. Its evidence (the reference used to find the original explanation) must point to this stable heading anchor.

## Implementation Intent Declaration

For the code stage, the author must add `**Implementation required**: yes/no` after the options, then pass `--needs-implementation true|false` when `finding-review` escalates to `needs-human-decision` or when calling `decision-upsert`. The value is stored as a predeclared implementation input, so maintainers normally omit this option from `ai decide`. Historical tasks without a declaration may still pass it explicitly to `ai decide`; a value that conflicts with an existing declaration is rejected.

## Decision Closure

Use `ai task decisions [--task <ref> | -t <ref>] [--item <ordinal|ledger-id> | -i <ordinal|ledger-id>]` to inspect full context and `ai decide [--task <ref> | -t <ref>] (--item <ordinal|ledger-id> | -i <ordinal|ledger-id>) <decision>` to record the ruling. `ai decide` updates the row to `human-decided`, creates an independent `HDR-N` record, and updates evidence and the activity log; do not manually imitate only part of that transaction.
