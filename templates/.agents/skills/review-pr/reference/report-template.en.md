# PR Review Report Template

Use the following structure when creating `pr-review.md` or `pr-review-r{N}.md`.

```markdown
# PR Review Report

- **Review Round**: Round {round}
- **Artifact File**: `pr-review.md` / `pr-review-r{N}.md`
- **Recoverable**: true (task-anchored path) / false (one-shot path)

## State Check

> Paste the state-check command output verbatim; each command starts with `$ `.

## Identity

- **PR Number**: {pr-number}
- **Base Branch**: {base-ref} (SHA `{base-sha}`)
- **Head Branch**: {head-ref}
- **Reviewed Head SHA**: {40 hex}
- **Linked Issue**: {issue-number or N/A}
- **Linked Task**: {task-id or N/A}
- **Task Directory**: {task-dir or N/A}

## Evidence List

- **Host Resolution**: `unique` / `ambiguous` / `none`
- **Evidence Scenario**: S{1|2|3}
- **Freshness**: `fresh` / `stale` / `n/a`
- **Alignment**: `aligned` / `misaligned` / `n/a`
- **Review Mode**: `verify` / `audit` / `reconstruct`
- **Risk Level**: `LOW` / `MEDIUM` / `HIGH`
- **First Review**: true / false
- **receipt**: {receipt}
- **Decision Input and Output**: paste the full `pr-review-grade decide` input JSON and the output DecisionRecord (the decision input includes host, artifact presence, head state, and the six risk factors).

### Reconstruction Context (reconstruct / audit with insufficient evidence)

Land the following in order before the line-level findings, without impersonating a standard lifecycle artifact:

1. **Requirement boundary**: what the PR does and does not do.
2. **Architecture choices**: key technical paths and trade-offs.
3. **Impact surface**: modules / rules / contracts touched.
4. **Validation coverage**: what tests should exist and whether current tests cover them.

## Coverage Matrix

| Review Surface | Evidence | Conclusion | Uncovered / Gap |
|----------------|----------|------------|-----------------|
| Requirement boundary | {evidence} | {conclusion} | {gap} |
| Architecture choices | {evidence} | {conclusion} | {gap} |
| Impact surface | {evidence} | {conclusion} | {gap} |
| Validation coverage | {evidence} | {conclusion} | {gap} |

## Findings

### Blockers (must fix)

- **{title}**: {description} · `{file}:{line}` · Evidence: {evidence} · Impact: {impact} · Suggestion: {suggestion}

### Major (should fix)

- **{title}**: {description} · `{file}:{line}` · Evidence: {evidence} · Impact: {impact} · Suggestion: {suggestion}

### Minor (low impact, close the loop)

- **{title}**: {description} · `{file}:{line}` · Evidence: {evidence} · Impact: {impact} · Suggestion: {suggestion}

## Publication Result

- **Formal Review Status**: {pending / applied / no-op / aborted / superseded / blocked / failed}
- **Review ID**: {review-id or N/A}
- **Review URL**: {review-url or N/A}
- **Issue Artifact Comment URL**: {comment-url or N/A}

## Evidence

> Every "I verified X" assertion must pair with the corresponding tool output verbatim; the gate only checks this section exists and has at least one `$ ` line.

- Assertion: {verified claim}
```text
$ {command}
{raw output}
```
