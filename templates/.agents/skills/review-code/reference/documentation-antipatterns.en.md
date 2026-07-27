# Documentation Anti-patterns

When reviewing new or changed documentation, require it to describe the current behavior after the change instead of using historical differences as a substitute for current facts.

## Backward-looking Descriptions of Removed Functionality

When functionality has been removed, current-behavior documentation should not keep saying that the functionality "no longer exists" or "was removed." Such wording keeps a deleted concept in the set of current knowledge that readers must understand.

Terms such as `不再`, `no longer`, `已被移除`, `removed`, and `used to` can locate candidate text, but a match is not a finding by itself. Judge the documentation's purpose and change context:

- Current reference documentation, rules, and usage instructions should directly describe supported behavior.
- Migration guides, changelogs, and historical records may preserve necessary before-and-after differences when their historical or migration context is explicit.
- Record a finding only when backward-looking wording preserves a deleted concept as current knowledge, and cite the exact file and line.
