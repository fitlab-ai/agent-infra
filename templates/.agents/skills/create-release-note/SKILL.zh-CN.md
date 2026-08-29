---
name: create-release-note
description: >
  从 PR 和 commit 生成版本发布说明。
  当准备发版、需要从 PR 与 commit 汇总发布说明时使用。
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

读取一次 typed 发布说明上下文，并参考预定义的完整分类清单：

执行前先读取 `.agents/rules/release-commands.md`。

```bash
agent-infra-internal platform-release-notes context \
  --from-tag "v<prev-version>" --to-tag "v<version>" \
  --branch "<base-branch>" --history-limit 3
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

### 4. 收集已合并的 PR 与贡献者

使用步骤 3 返回的 `pullRequests` 与 `commits`。每个 commit 的 `authors` 已按平台事实规范化并包含 git author 与 co-author；技能不读取平台原始字段或邮箱规则。

### 5. 收集关联 Issue

使用步骤 3 中每个 PR 的 `closingIssues`，不在通用技能中解析平台专有引用语法。

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

@contributor1, @contributor2, @contributor3, @reporter1 (reported #N)
```

**格式规则**：
1. 条目格式：`- [scope] Description by @author in [#N](url)`
2. Issue + PR：`in [#Issue](url) and [#PR](url)`
3. 描述：使用 PR 标题，移除 `type(scope):` 前缀，首字母大写
4. **贡献者搜集**：
   - **数据源**：
     - PR author：来自 `.agents/rules/release-commands.md` 中已合并 PR 查询规则
     - Commit co-authors：来自步骤 3 typed context 的 commit `authors`
     - Issue reporters：来自步骤 3 typed context 的 `closingIssues[].author`
   - **贡献数定义**：`该人的 PR 数 + 该人作为 co-author 的 commit 数`（同一身份跨来源合并计数）
   - **`@login` 映射**：遵循 `.agents/rules/release-commands.md` 的身份安全边界
     - `resolution` 为 `platform-user` 或 `platform-noreply` 且 `login` 非空时，采用小写 `login`
     - `resolution` 为 `unresolved` 时从贡献者列表中排除；不得从 Name、邮箱、域名、品牌或同名平台账号推断 login
     - 同一 typed login 的所有 Name 变体必须归并后再计数与排序
     - Bot 身份保留原样（如 `dependabot[bot]`）
     - 不得在可发布 notes 中加入未解析身份的邮箱、占位 mention 或身份确认 TODO
   - **排序**：按贡献数降序；贡献数相同时按 login 字典序
   - **去重**：以最终映射后的 `@login` 为键
   - **Issue reporter 规则**：
     - 从步骤 5 收集到的每个关联 Issue 中提取 `author.login`
     - 如果该 login 已存在于 PR author 或 co-author 的最终映射列表中，跳过（代码贡献已包含该用户）
     - 仅报告贡献的用户以 `@login (reported #N)` 格式展示；同一 reporter 报告多个 Issue 时使用 `@login (reported #N1, #N2)`
     - Reporter 在 Contributors 段落中排在代码贡献者之后，以逗号分隔追加
     - Reporter 之间按报告的 Issue 数量降序排列，数量相同时按 login 字典序
5. 空部分：省略没有条目的部分

### 8. Stage、展示并确认

把候选 notes 写入工作树外临时文件，调用 typed stage 规范化并保存结构化 `sha256`：

```bash
NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/agent-infra-release-notes.XXXXXX")"
agent-infra-internal platform-release-notes stage \
  --notes-file "$NOTES_FILE"
```

只展示 stage 后同一文件的精确内容，在询问前删除文件。调整会使旧 digest 失效。只有当前会话中针对当前预览的无歧义明确肯定答复才授权发布；否定、疑问、歧义或中断均停止。

### 9. 复核并发布 Release notes

确认后把已确认文本写入新的工作树外临时文件并再次 stage。digest 不一致时删除并回到预览；一致时调用：

```bash
agent-infra-internal platform-release-notes publish \
  --tag "v<version>" \
  --title "v<version>" \
  --notes-file "$NOTES_FILE" \
  --expected-sha256 "{preview-sha256}"
```

所有退出路径删除临时文件。成功后渲染：

```bash
agent-infra-internal agent-client next-steps \
  --skill post-release \
  --version <version>
```

输出：
```
Release notes 已更新。

- URL: {release-url}
- Version: v{version}
- Status: Published

发布说明已写入该 Release。如需进一步调整，可在上面的 URL 直接编辑。
```

## 注意事项

1. **需要 the platform CLI**：必须安装并认证 the platform CLI
2. **标签必须存在**：先执行 release 技能创建标签
3. **Release 已自动发布**：`v{version}` 的 Release 由 release 工作流自动创建并发布（给 Homebrew bottle 提供上传落点）；本技能往该 Release 写入/刷新 notes
4. **分类准确性**：自动分类基于标题/scope/文件；复杂的 PR 可能需要手动调整
5. **不留残留产物**：预览文件在询问前删除，发布文件在所有退出路径删除；会话中断时授权和草稿失效

## 错误处理

- 版本格式无效：提示正确格式
- 标签未找到：建议先执行 release 技能
- 平台 CLI 未认证：提示用户认证
- 未找到已合并的 PR：提示检查标签和分支
