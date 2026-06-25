# Issue 字段

写入或校验 Issue Type pinned custom fields 前先读取本文件。

## 边界

- 仅在已知 `upstream_repo`、`has_push` 和 Issue 编号后使用本规则。
- 如果 `has_push=false`，跳过直接字段写入并继续流程。
- 每次写入前都读取组织当前 Issue Type schema；不要硬编码字段集合。
- 缺失、空值或无法解析的值直接跳过。字段写入是 best-effort，不应阻断工作流。

## 支持的 task.md frontmatter

所有字段均可选：

| task.md 字段 | Issue 字段 | 值格式 |
|---|---|---|
| `priority` | `Priority` | `Urgent`、`High`、`Medium` 或 `Low` |
| `effort` | `Effort` | `High`、`Medium` 或 `Low` |
| `start_date` | `Start date` | `YYYY-MM-DD` |
| `target_date` | `Target date` | `YYYY-MM-DD` |

写入前可规范化本地化选项：

| 输入 | 写入选项 |
|---|---|
| `紧急` | `Urgent` |
| `高` | `High` |
| `中` | `Medium` |
| `低` | `Low` |

AI agent 在创建或修订任务时可根据标题与描述推断 `priority` 和 `effort`。日期字段为事实值、不估算：`start_date` 由 analyze 阶段写入（= 分析开始日），`target_date` 由 complete 阶段写入（= 完成日）。`task.md` 中人工填写的值优先。

## GraphQL 参考

读取 Issue Type pinned fields：

```graphql
query($owner:String!){
  organization(login:$owner){ issueTypes(first:20){ nodes{
    id name
    pinnedFields{
      __typename
      ... on IssueFieldSingleSelect{ id name options{ id name } }
      ... on IssueFieldDate{ id name }
      ... on IssueFieldText{ id name }
      ... on IssueFieldNumber{ id name }
    }
  } } }
}
```

读取单个 Issue 的当前 type 与字段值：

```graphql
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ issue(number:$number){
    id
    issueType{ name pinnedFields{
      __typename
      ... on IssueFieldSingleSelect{ id name options{ id name } }
      ... on IssueFieldDate{ id name }
      ... on IssueFieldText{ id name }
      ... on IssueFieldNumber{ id name }
    } }
    issueFieldValues(first:50){ nodes{
      __typename
      ... on IssueFieldSingleSelectValue{ name optionId field{ ... on IssueFieldSingleSelect{ name } } }
      ... on IssueFieldDateValue{ value field{ ... on IssueFieldDate{ name } } }
      ... on IssueFieldTextValue{ value field{ ... on IssueFieldText{ name } } }
      ... on IssueFieldNumberValue{ value field{ ... on IssueFieldNumber{ name } } }
    } }
  } }
}
```

写入或清空字段，以及更新 Issue Type：

```graphql
mutation($issueId:ID!,$issueFields:[IssueFieldCreateOrUpdateInput!]!){
  setIssueFieldValue(input:{issueId:$issueId,issueFields:$issueFields}){ issue{ id } }
}

mutation($issueId:ID!,$issueTypeId:ID){
  updateIssueIssueType(input:{issueId:$issueId,issueTypeId:$issueTypeId}){ issue{ id } }
}
```

`IssueFieldCreateOrUpdateInput` 支持 `fieldId`、`singleSelectOptionId`、`dateValue`、`textValue`、`numberValue` 和 `delete`。

最小命令壳：

```bash
gh api graphql \
  -f query='query($owner:String!){organization(login:$owner){issueTypes(first:20){nodes{id name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}}}}}' \
  -F owner="{owner}"

gh api graphql \
  -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id issueType{name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}} issueFieldValues(first:50){nodes{__typename ... on IssueFieldSingleSelectValue{name optionId field{... on IssueFieldSingleSelect{name}}} ... on IssueFieldDateValue{value field{... on IssueFieldDate{name}}} ... on IssueFieldTextValue{value field{... on IssueFieldText{name}}} ... on IssueFieldNumberValue{value field{... on IssueFieldNumber{name}}}}}}}}' \
  -F owner="{owner}" -F name="{repo}" -F number="{issue-number}"

gh api graphql --input - <<'JSON'
{
  "query": "mutation($issueId:ID!,$issueFields:[IssueFieldCreateOrUpdateInput!]!){setIssueFieldValue(input:{issueId:$issueId,issueFields:$issueFields}){issue{id}}}",
  "variables": {
    "issueId": "{issue-id}",
    "issueFields": [
      { "fieldId": "{field-id}", "singleSelectOptionId": "{option-id}" },
      { "fieldId": "{date-field-id}", "dateValue": "YYYY-MM-DD" },
      { "fieldId": "{old-field-id}", "delete": true }
    ]
  }
}
JSON

gh api graphql --input - <<'JSON'
{
  "query": "mutation($issueId:ID!,$issueTypeId:ID){updateIssueIssueType(input:{issueId:$issueId,issueTypeId:$issueTypeId}){issue{id}}}",
  "variables": {
    "issueId": "{issue-id}",
    "issueTypeId": "{issue-type-id}"
  }
}
JSON
```

未列入本地化映射表的值会按字面量 option name 处理；这是为了支持规范英文输入。

## 流程 A：创建 Issue 后写入字段

1. 如果 `has_push` 不是 `true`，停止本流程。
2. 从 `$upstream_repo` 解析 `{owner}`，查询 `organization.issueTypes`。
3. 选择目标 Issue Type 的 `pinnedFields`。
4. 从 `task.md` 读取非空的 `priority`、`effort`、`start_date` 和 `target_date`。
5. 对每个值：
   - 目标 type 未 pin 同名字段时跳过。
   - single-select 字段先规范化本地化输入，再按 option name 匹配。
   - date 字段只写入 `YYYY-MM-DD` 值。
6. 用所有已解析 input 一次性提交 `setIssueFieldValue` mutation。没有 input 时跳过。

## 流程 B：设置 Type 并迁移字段

现有 Issue Type 发生变更时使用本流程。

1. 如果 `has_push` 不是 `true`，停止本流程。
2. 读取 Issue id、当前 Issue Type、pinned fields 和当前字段值。
3. 查询组织 Issue Type 列表，解析目标 Issue Type id。
4. 用目标 Issue Type id 执行 `updateIssueIssueType`。
5. 解析目标 type 的 pinned fields。
6. 对每个旧字段值：
   - 目标 type 有同名字段时重新写入该值。single-select 值按 option name 在目标 type 中重新解析 option id。
   - 目标 type 没有同名字段时，对旧字段发送 `{ fieldId, delete: true }`。
7. 用所有迁移 input 一次性提交 `setIssueFieldValue` mutation。迁移 input 为空时跳过。

两个流程均应保持幂等。重复写入未变化的值或删除已为空字段都是可接受的。
