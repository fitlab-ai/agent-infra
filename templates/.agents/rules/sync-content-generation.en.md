# Synchronized Content Generation Rules

This rule applies to controlled generators that write `task.md` or lifecycle artifacts which are synchronized to an Issue. It constrains model output only; it does not parse, rewrite, or block hand-written or external content.

- Render local, workspace, and temporary task-file references as inline code, such as `analysis.md` or `/workspace/file.md`; do not write them as Markdown links.
- Render non-user-semantic `@` text, such as `@2x`, as inline code; preserve real user mentions, `@` inside email addresses, and fixed release-log formats according to their meaning.
- Formal Issue, PR, commit, and external links may remain Markdown links.
- When uncertain, keep ordinary text and do not guess a link target; do not introduce a runtime Markdown parser for this purpose.
