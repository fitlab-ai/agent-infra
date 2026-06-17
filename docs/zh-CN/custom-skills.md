# 自定义 Skills

[← 返回 README](../../README.zh-CN.md) · [English](../en/custom-skills.md)

内置 skills 覆盖了标准交付生命周期，但很多团队还需要项目特有的指令，例如编码规范、发布检查或内部审查规则。agent-infra 通过**自定义 skill**支持这些场景。

## 在项目中创建自定义 skill

在 `.agents/skills/<name>/` 下创建目录，并添加 `SKILL.md`：

```text
.agents/skills/
  enforce-style/
    SKILL.md
    reference/
      style-guide.md
```

最小 frontmatter 示例：

```yaml
---
name: enforce-style
description: "在提交代码前执行团队风格检查"
args: "<task-id>"   # 可选
---
```

- `name`：对用户可见的 skill 名称
- `description`：用于生成编辑器命令元数据
- `args`：可选参数提示；agent-infra 会在生成支持的 AI TUI 命令时使用它

添加 skill 后，再执行一次 `update-agent-infra`：

| TUI | 命令 |
|-----|------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Gemini CLI | `/{{project}}:update-agent-infra` |
| OpenCode | `/update-agent-infra` |

同步时会自动检测 `.agents/skills/` 下的非内置 skill 目录，并为 Claude Code、Gemini CLI、OpenCode 生成对应命令。

## 从共享源同步自定义 skills

如果团队在仓库外统一维护可复用 skill，可以在 `.agents/.airc.json` 中声明：

```json
{
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" },
      { "type": "local", "path": "~/team-skills" }
    ]
  }
}
```

源目录结构示例：

```text
~/private-skills/
  enforce-style/
    SKILL.md
  release-check/
    SKILL.md
    reference/
      checklist.md
```

行为说明：

- 多个 source 按数组顺序应用；后面的 source 如果定义了同名文件，会覆盖前面的自定义 source 文件
- 当前只支持 `type: "local"`；配置结构已为未来扩展其他来源类型预留
- source 路径中的 `~` 会自动展开为当前用户的 home 目录

## 同步行为与冲突规则

执行 `update-agent-infra` 时：

- 手动放在 `.agents/skills/` 下的自定义 skill 不会被 managed 文件清理删除
- 外部 source 中的 skill 会同步复制到 `.agents/skills/`
- 对于仍存在于配置 source 中的 skill，如果源里删掉某个文件，下次同步时本地对应残留文件也会被删除
- 内置 skill 始终优先于自定义 source；如果 source 里出现与内置 skill 同名的目录，agent-infra 会跳过该 source skill，而不是覆盖内置实现
- 如果你确实需要替换内置 skill 或命令，请使用现有的 `ejected` 机制，让项目自己接管该文件
