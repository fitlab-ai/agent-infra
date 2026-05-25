# Issue Fields

Read this file before writing or verifying Issue Type pinned custom fields.

## Boundary

- Use this rule only after `upstream_repo`, `has_push`, and the Issue number are known.
- If `has_push=false`, skip direct field writes and continue.
- Fetch the organization's current Issue Type schema before each write; do not hard-code the field set.
- Missing, empty, or unresolvable values are skipped. Field writes are best-effort and must not block the workflow.

## Supported Task Frontmatter

All fields are optional:

| task.md field | Issue field | Value format |
|---|---|---|
| `priority` | `Priority` | `Urgent`, `High`, `Medium`, or `Low` |
| `effort` | `Effort` | `High`, `Medium`, or `Low` |
| `start_date` | `Start date` | `YYYY-MM-DD` |
| `target_date` | `Target date` | `YYYY-MM-DD` |

Localized option input may be normalized before writing:

| Input | Stored option |
|---|---|
| `紧急` | `Urgent` |
| `高` | `High` |
| `中` | `Medium` |
| `低` | `Low` |

AI agents may infer `priority` and `effort` from the title and description when creating or refining tasks, but must keep date fields empty unless the user or source Issue provides explicit dates. Human edits in `task.md` take precedence.

## GraphQL Reference

Read Issue Type pinned fields:

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

Read one Issue's current type and field values:

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

Write or clear fields and update Issue Type:

```graphql
mutation($issueId:ID!,$issueFields:[IssueFieldCreateOrUpdateInput!]!){
  setIssueFieldValue(input:{issueId:$issueId,issueFields:$issueFields}){ issue{ id } }
}

mutation($issueId:ID!,$issueTypeId:ID){
  updateIssueIssueType(input:{issueId:$issueId,issueTypeId:$issueTypeId}){ issue{ id } }
}
```

`IssueFieldCreateOrUpdateInput` supports `fieldId`, `singleSelectOptionId`, `dateValue`, `textValue`, `numberValue`, and `delete`.

Minimal command shells:

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

Values not listed in the localization table are treated as literal option names, which is intended for canonical English input.

## Flow A: Write Fields After Issue Creation

1. Stop if `has_push` is not `true`.
2. Resolve `{owner}` from `$upstream_repo` and query `organization.issueTypes`.
3. Select the target Issue Type's `pinnedFields`.
4. Read non-empty `priority`, `effort`, `start_date`, and `target_date` values from `task.md`.
5. For each value:
   - Skip it when the target type does not pin a same-name field.
   - For single-select fields, normalize localized input and match the option by name.
   - For date fields, write only `YYYY-MM-DD` values.
6. Submit one `setIssueFieldValue` mutation with all resolved inputs. If no input remains, skip.

## Flow B: Set Type And Migrate Fields

Use this flow whenever an existing Issue Type is changed.

1. Stop if `has_push` is not `true`.
2. Read the Issue id, current Issue Type, pinned fields, and current field values.
3. Query the organization Issue Type list and resolve the target Issue Type id.
4. Run `updateIssueIssueType` with the target Issue Type id.
5. Resolve the target type's pinned fields.
6. For each old field value:
   - If the target type has a same-name field, write the value again. For single-select values, resolve the target option id by option name.
   - If the target type does not have a same-name field, send `{ fieldId, delete: true }` for the old field.
7. Submit one `setIssueFieldValue` mutation with all migration inputs. Empty migrations are skipped.

Both flows are idempotent. Rewriting an unchanged value or deleting an already empty field is acceptable.
