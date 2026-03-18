# Codex Skills（agent-infra）

本项目使用 Codex 原生 skills。

## 直接使用 Skills

- 技能文件位于 `.agents/skills/`
- 使用 `$skill-name` 调用

示例：

```text
$update-agent-infra
$create-task 给 postman 添加优雅停机功能
$analyze-task TASK-20260310-105622
$import-issue 207
$plan-task TASK-20260310-105622
```

## 命令定义在哪里

Codex 会直接读取项目内的技能文件，例如：

- `.agents/skills/update-agent-infra/SKILL.md`
- `.agents/skills/create-task/SKILL.md`
- `.agents/skills/analyze-task/SKILL.md`
- `.agents/skills/implement-task/SKILL.md`

`.codex/` 目录用于存放本项目的 Codex 使用文档。

## 常见问题

### Q: Skills 是如何解析的？

A: Codex 会从当前项目目录中发现并加载 skills。

### Q: 如何自定义工作流？

A: 直接编辑 `.agents/skills/` 下对应的 `SKILL.md`。如果是在模板仓库中维护，
则同步修改 `templates/.agents/skills/` 中的对应文件。
