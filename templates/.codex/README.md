# Codex Skills ({{project}})

This project uses native Codex skills.

## Use Skills Directly

- Skills live in `.agents/skills/`
- Invoke them with `$skill-name`

Examples:

```text
$update-agent-infra
$create-task add graceful shutdown support
$plan-task TASK-20260310-105622
```

## Where Commands Live

Codex reads the actual workflow instructions from the project-local skill
files, for example:

- `.agents/skills/update-agent-infra/SKILL.md`
- `.agents/skills/create-task/SKILL.md`
- `.agents/skills/implement-task/SKILL.md`

The `.codex/` directory contains project documentation for Codex usage.

## FAQ

### Q: How are skills resolved?

A: Codex discovers skills from the current project directory.

### Q: How do I customize a workflow?

A: Edit the corresponding `SKILL.md` file under `.agents/skills/`. Template
projects should update the matching file under `templates/.agents/skills/`.
