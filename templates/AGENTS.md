# agent-infra - AI Development Guide

This repository contains the agent-infra template and skill repository for multi-AI collaboration infrastructure.

## Quick Start Commands

<!-- TODO: Add your project's build commands here -->
```bash
# Example (replace with your project's commands):
# npm install / mvn clean install / pip install -r requirements.txt
# npm run build / mvn package / make build
# npm test / mvn test / pytest
# npm run lint / mvn checkstyle:check / flake8
```

## Coding Standards (Required)

<!-- TODO: Add your project's coding standards here -->

### Copyright Header Update Rules
When modifying any file with a copyright header, you must update the copyright year:
1. Run `date +%Y` to get the current year (never hardcode)
2. Update format example (assuming current year is 2026):
   - `2024-2025` -> `2024-2026`
   - `2024` -> `2024-2026`

### Branch Naming
Use project prefix: `{{project}}-feature-xxx`, `{{project}}-bugfix-yyy`

## Project Structure

<!-- TODO: Add your project's directory structure here -->

## Testing Requirements

<!-- TODO: Add your project's test framework and commands here -->

## Commit and PR Conventions

### Commit Message Format (Conventional Commits)
```
<type>(<scope>): <subject>

Examples:
feat(module): add new feature
fix(module): fix critical bug
docs(module): update documentation
refactor(module): refactor internal logic
```

- **type**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **scope**: module name (optional)
- **subject**: English, imperative mood, max 50 characters

### PR Checklist
Before submitting a PR, ensure:
- [ ] All tests pass
- [ ] Lint checks pass
- [ ] Build succeeds
- [ ] Public APIs have documentation
- [ ] Copyright headers updated (if applicable)

## Security Notes

- Do not commit sensitive files: `.env`, `credentials.json`, keys, etc.
- Report security issues per `SECURITY.md` guidelines (do not open public Issues)

## Multi-AI Collaboration Support

This project supports Claude Code, Codex, Gemini CLI, OpenCode and other AI tools working together.

**Collaboration config directory**:
- `.agents/` - AI configuration and workflow definitions (version controlled)

**Language conventions**:

All code-level content uses **English**. Documentation provides **multilingual versions** (English as primary).

| Context | Language | Notes |
|---------|----------|-------|
| Code identifiers, JSDoc/TSDoc | English | Code is documentation |
| CLI help text, error messages | English | For all users |
| Git commit messages | English | Conventional Commits imperative mood |
| Project documentation | English (primary) + Chinese translation | e.g. `README.md` + `README.zh-CN.md` |
| AI responses | Follow user's input language | Chinese question -> Chinese answer |

<!-- TODO: Add your project's tech stack here -->

## Skill Authoring Conventions

When writing or updating `.agents/skills/*/SKILL.md` files, keep step numbering consistent:

1. Use consecutive integers for top-level steps: `1.`, `2.`, `3.`.
2. Use nested numbering only for child actions that belong to a parent step: `1.1`, `1.2`, `2.1`.
3. Use `a`, `b`, and `c` markers for branches, conditions, or alternative paths within the same step.
4. Do not use intermediate numbers such as `1.5` or `2.5`; if a new standalone step is needed, renumber the following top-level steps.
5. When renumbering, update every in-document step reference so the instructions remain accurate.
6. Extract long bash scripts into a sibling `scripts/` directory; the SKILL.md should contain only a single-line invocation (e.g., `bash .agents/skills/<skill>/scripts/<script>.sh`) and a brief summary of the script's responsibilities.

<!-- Canonical source: .agents/README.md - keep in sync -->

---

**Based on standard**: [AGENTS.md](https://agents.md) (Linux Foundation AAIF)
