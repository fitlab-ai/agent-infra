---
name: create-release-note
description: >
  从 PR 和 commit 生成版本发布说明。
  当用户要求生成发布说明时触发。参数：版本号，可选的上一版本号。
---

# 创建发布说明

基于已合并的 PR 和提交，为指定版本生成全面的发布说明。

## 执行流程

### 步骤 1：解析参数

从参数中提取：
- `<version>`：当前发布版本（必需），格式 `X.Y.Z`
- `<prev-version>`：上一版本（可选），如未提供则自动检测

### 步骤 2：确定版本范围

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

### 步骤 3：收集已合并的 PR

获取标签之间的日期范围，然后查询已合并的 PR：

```bash
# 获取标签日期
git log v<prev-version> --format=%aI -1
git log v<version> --format=%aI -1

# 获取范围内已合并的 PR
gh pr list --state merged --base <branch> \
  --json number,title,body,author,labels,mergedAt,url \
  --limit 200 --search "merged:YYYY-MM-DD..YYYY-MM-DD"
```

同时收集没有 PR 的直接提交：
```bash
git log v<prev-version>..v<version> --format="%H %s" --no-merges
```

### 步骤 4：收集关联 Issue

从每个 PR body 中提取关联的 Issue：
- 匹配模式：`Closes #N`、`Fixes #N`、`Resolves #N`（不区分大小写）

```bash
gh issue view <N> --json number,title,labels,url
```

### 步骤 5：分类变更

**按类型**（从 PR 标题的 Conventional Commit 前缀）：
- `feat`、`perf`、`refactor`、依赖升级 -> Enhancement
- `fix` -> Bugfix
- `docs` -> Documentation（如少于 3 项则合并到 Enhancement）

**按模块**（从 PR 标题 scope、标签或文件路径）：
- 从 PR 标题中的方括号 `[module]` 或 Conventional scope `feat(module):` 推断模块
- 兜底：分析变更的文件

### 步骤 6：生成发布说明

格式化为 Markdown：

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

### 步骤 7：展示并确认

向用户展示生成的发布说明。

询问：
1. 需要调整吗？
2. 是否创建 GitHub Draft Release？

### 步骤 8：创建 Draft Release（如确认）

```bash
gh release create v<version> \
  --title "v<version>" \
  --notes-file /tmp/release-notes-v<version>.md \
  --draft
```

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
