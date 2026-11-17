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
disable-model-invocation: true   # 可选；由支持该能力的 TUI 适配器消费
---
```

- `name`：对用户可见的 skill 名称
- `description`：用于生成编辑器命令元数据
- `args`：可选参数提示；agent-infra 会在生成支持的 AI TUI 命令时使用它
- `disable-model-invocation`：可选通用元数据；各 TUI 适配器按自身能力决定是否消费

多行 `description` 如需保留换行，使用 YAML literal block（`|`）；同步器会为各 TUI 输出对应的多行元数据格式。

使用 `ai skill add <name>` 显式登记一次，再执行 `update-agent-infra` 同步：

| TUI | 命令 |
|-----|------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Antigravity CLI | `/update-agent-infra` |
| OpenCode | `/update-agent-infra` |

只有内置 skill 和显式登记的自定义 skill 会参与同步并生成客户端命令。修改已登记 skill 后，直接执行 `update-agent-infra`，不要重复添加。Antigravity CLI 对共享目录的直接发现由客户端自身决定，不属于同步器行为。

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

- source 用于发现候选。登记 skill 时需选择一个具体来源路径；多个 source 中的同名候选会显示为冲突，不会合并文件，也不会按数组顺序覆盖
- 当前只支持 `type: "local"`；配置结构已为未来扩展其他来源类型预留
- source 路径中的 `~` 会自动展开为当前用户的 home 目录

## 同步行为与冲突规则

执行 `update-agent-infra` 时：

- 项目托管目录 `.agents/skills/` 下的未登记 skill 会被删除。只要旧技能目录仍存在，同步器也会按客户端 adapter manifest 从技能名推导命令目标并清理，包括已修改或没有基线的文件
- 如果对应技能目录已不存在、只剩孤立命令，同步器不会按命令名称猜测来源；该文件继续遵守客户端 managed 文件的基线规则
- 外部 source 中的 skill 会同步复制到 `.agents/skills/`
- `ai skill remove` 会解除登记并在执行时保留源目录。之后的完整同步会清理项目托管 `.agents/skills/` 中未登记的技能及其可推导命令；外部 source 根目录不在清理范围内
- 对于仍存在于配置 source 中的 skill，如果源里删掉某个文件，下次同步时本地对应残留文件也会被删除
- 内置 skill 始终优先于自定义 source；如果 source 里出现与内置 skill 同名的目录，agent-infra 会跳过该 source skill，而不是覆盖内置实现
- 如果你确实需要替换内置 skill 或命令，请使用现有的 `ejected` 机制，让项目自己接管该文件
