---
name: create-release-note
description: "从 PR 和 commit 生成版本发布说明"
---

# 创建发布说明

基于已合并的 PR 和提交，为指定版本生成全面的发布说明。

## 执行流程

### 1. 解析参数

从参数中提取：
- `<version>`：当前发布版本（必需），格式 `X.Y.Z`
- `<prev-version>`：上一版本（可选），如未提供则自动检测

### 2. 确定版本范围

**当前标签**：`v<version>`

**上一标签**（如未指定）：
```bash
git tag --sort=-v:refname
```
查找 `v<version>` 之前最近的标签。

**验证标签存在**：
```bash
git rev-parse v<version>
git rev-parse v<prev-version>
```

### 3. 参考历史发布说明格式与分类

获取最近多条已发布的 Release Note 作为格式参考，并参考预定义的完整分类清单：

执行前先读取 `.agents/rules/release-commands.md`。

```bash
# Part A：按 `.agents/rules/release-commands.md` 的 release 查询命令逐条获取最近 3 条 Release 的 body
```

**Part B：完整分类清单**
- `🆕 Feature`
- `✨ Enhancement`
- `✅ Bugfix`
- `📚 Documentation`

**用途**：
- Part A：分析最近 3 条历史发布说明的章节结构、标题风格、emoji 使用、条目格式
- Part B：提供静态完整分类清单，确保后续生成时不遗漏已有分类
- 该静态清单用于确保变更分类时不遗漏已有类别名称；若当前版本无该类变更，仍按步骤 7 的格式规则省略空分类
- 后续步骤 7 生成发布说明时，**必须**同时参考步骤 3 的历史格式风格和完整分类清单，保持版本间的一致性
- 如果没有历史发布说明，则使用步骤 7 中定义的默认格式

### 4. 收集已合并的 PR

获取标签之间的日期范围，然后查询已合并的 PR：

```bash
# 获取标签日期
git log v<prev-version> --format=%aI -1
git log v<version> --format=%aI -1

# 获取范围内已合并的 PR（按 `.agents/rules/release-commands.md` 的 merged PR 查询命令执行）
```

同时收集没有 PR 的直接提交：
```bash
git log v<prev-version>..v<version> --format="%H %s" --no-merges
```

### 5. 收集关联 Issue

从每个 PR body 中提取关联的 Issue：
- 匹配模式：`Closes #N`、`Fixes #N`、`Resolves #N`（不区分大小写）

按 `.agents/rules/release-commands.md` 的关联 Issue 查询命令读取。

### 6. 分类变更

**按类型**（从 PR 标题的 Conventional Commit 前缀）：
- `feat`、`perf`、`refactor`、依赖升级 -> Enhancement
- `fix` -> Bugfix
- `docs` -> Documentation（如少于 3 项则合并到 Enhancement）

**按模块**（从 PR 标题 scope、标签或文件路径）：
- 从 PR 标题中的方括号 `[module]` 或 Conventional scope `feat(module):` 推断模块
- 兜底：分析变更的文件

### 7. 生成发布说明

**优先使用步骤 3 中获取的历史格式风格，并确保覆盖步骤 3 列出的所有分类。** 如果存在历史发布说明，严格沿用其章节结构、标题风格（含 emoji）、条目格式和双语布局。

如果没有历史发布说明，使用以下默认格式化为 Markdown：

```markdown
## {模块/平台名称}

### Enhancement

- [{scope}] Description by @author in [#N](url)

### Bugfix

- [{scope}] Description by @author in [#N](url)

## Contributors

@contributor1, @contributor2, @contributor3
```

**格式规则**：
1. 条目格式：`- [scope] Description by @author in [#N](url)`
2. Issue + PR：`in [#Issue](url) and [#PR](url)`
3. 描述：使用 PR 标题，移除 `type(scope):` 前缀，首字母大写
4. 贡献者：去重，按贡献数量降序排列
5. 空部分：省略没有条目的部分

### 8. 展示并确认

向用户展示生成的发布说明。

询问：
1. 需要调整吗？
2. 是否创建 GitHub Draft Release？

### 9. 创建 Draft Release（如确认）

按 `.agents/rules/release-commands.md` 的 Draft Release 创建命令执行。

输出：
```
Draft Release created.

- URL: {draft-release-url}
- Version: v{version}
- Status: Draft

Please review and publish on GitHub:
1. Open the URL above
2. Review the release notes
3. Click "Publish release"
```

## 注意事项

1. **需要 gh CLI**：必须安装并认证 GitHub CLI
2. **标签必须存在**：先执行 release 技能创建标签
3. **草稿模式**：创建草稿 —— 不会自动发布
4. **分类准确性**：自动分类基于标题/scope/文件；复杂的 PR 可能需要手动调整

## 错误处理

- 版本格式无效：提示正确格式
- 标签未找到：建议先执行 release 技能
- gh 未认证：提示进行认证
- 未找到已合并的 PR：提示检查标签和分支
