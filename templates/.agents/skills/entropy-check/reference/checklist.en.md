# Entropy Check Checklist

## 1. Issue/PR Rule Boundaries

Inspect these six rule files for overlapping responsibilities, duplicate maintenance, or unclear boundaries:

- `.agents/rules/issue-sync.md`
- `.agents/rules/issue-pr-commands.md`
- `.agents/rules/issue-fields.md`
- `.agents/rules/pr-sync.md`
- `.agents/rules/pr-checks-commands.md`
- `.agents/rules/create-issue.md`

## 2. SKILL.md Growth

Check `.agents/skills/*/SKILL.md` line counts and structure. Long templates, scripts, or detailed rules should move to `reference/` or `scripts/`.

## 3. Over-design, Dead Conventions, and Duplicate Rules

Look for rules, templates, or tests that no longer have an execution path, duplicate another source, or preserve a removed concept.

## 4. Bilingual Naming

Check that both conventions have clear boundaries:

- Top-level docs: `X.md` + `X.zh-CN.md`
- Templates and skill variants: `X.en.md` + `X.zh-CN.md`

## 5. Version Scattering

Inspect version references in package metadata, lockfiles, `.agents/.airc.json`, generated inline artifacts, release docs, and security support tables.
