---
name: entropy-check
description: >
  Review soft project entropy periodically and write a structured entropy-check report.
  Use before releases or maintenance windows to find rule overlap, document growth, dead conventions, and scattered version risks.
---

# Entropy Check

## Boundary / Critical Rules

- Do not modify product code, rules, skills, or documentation; only create one review report.
- Write the report to `.agents/workspace/logs/entropy-check/entropy-check-YYYYMMDD-HHMMSS.md`.
- Findings provide evidence and recommendations only; do not create tasks or edit files automatically.
- Put unresolved boundary choices in `## Human Decision Items`; do not ask mid-flow questions.

## Steps

### 1. Create Report Directory and Capture State

Create the output directory:

```bash
mkdir -p .agents/workspace/logs/entropy-check
```

Run these commands and paste the raw output into `## State Check`:

```bash
git status -s
git branch --show-current
date "+%Y-%m-%d %H:%M:%S%:z"
```

### 2. Read Review References

Before reviewing, read:

- `reference/checklist.md`
- `reference/report-template.md`

### 3. Collect Evidence

Collect evidence for every checklist area with reproducible commands such as `rg`, `find`, `wc -l`, and `git status`.

### 4. Review Soft Entropy

Use `reference/checklist.md` to classify findings. Mark only issues that must be handled before release as `release-blocking`.

### 5. Write the Report

Use `reference/report-template.md` and create:

```bash
report=".agents/workspace/logs/entropy-check/entropy-check-$(date "+%Y%m%d-%H%M%S").md"
```

### 6. Output the Result

Print the report path and finding counts. If any `release-blocking` finding exists, state that release should pause until it is fixed or manually accepted.
