# 熵减审查清单

## 1. Issue/PR 规则边界

检查以下六篇规则是否出现职责交叠、重复维护或边界漂移：

- `.agents/rules/issue-sync.md`
- `.agents/rules/issue-pr-commands.md`
- `.agents/rules/issue-fields.md`
- `.agents/rules/pr-sync.md`
- `.agents/rules/pr-checks-commands.md`
- `.agents/rules/create-issue.md`

关注点：
- 同一平台 Issue / PR 操作是否被多篇规则重复定义。
- marker、评论、label、milestone、Issue fields 的唯一权威是否清晰。
- 某篇规则是否已经变成多个主题的堆叠，应拆分或重划边界。

## 2. SKILL.md 膨胀

检查 `.agents/skills/*/SKILL.md` 的行数和结构：

```bash
find .agents/skills -name SKILL.md -print0 | xargs -0 wc -l | sort -n
```

关注点：
- `SKILL.md` 是否超过软阈值并包含长模板、长脚本或大量规则细节。
- 是否可以把细节移动到 `reference/` 或 `scripts/`。
- 主流程是否仍然薄而清晰。

## 3. over-design、死约定与重复规则

检查现有规则、模板和测试是否包含无法触发、没有调用入口或多处重复维护的约定。

关注点：
- 规则是否描述了当前仓库不存在的流程。
- 模板和运行态文件是否长期漂移。
- 测试是否在记住已删除概念，或用自然语言措辞断言制造维护债务。

## 4. bilingual 命名约定

检查双语文件命名是否边界清晰：

- 顶层文档：`X.md` + `X.zh-CN.md`
- 模板和 skill 变体：`X.en.md` + `X.zh-CN.md`

关注点：
- 是否有目录混用两套约定但没有理由。
- 新增模板是否成对存在。
- 测试是否能结构性覆盖命名约定。

## 5. version 散落点

检查 version 信息是否容易漂移：

- `package.json`
- `package-lock.json`
- `.agents/.airc.json`
- 内联生成脚本
- release / post-release 文档
- 安全支持版本表格

关注点：
- 是否有未被 release 流程覆盖的版本引用。
- 是否存在手写示例与真实版本可能冲突。
- 是否需要生成、同步或单一事实源。
