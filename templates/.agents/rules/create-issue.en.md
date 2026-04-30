# Issue Creation

This code platform does not provide an Issue creation rule.

`create-task` skips the cascade Issue creation step on this platform; the local `task.md` remains a valid artifact. If you later want to bind the task to an Issue, manually write `issue_number` into `task.md` and the subsequent skills (`commit` / `refine-task` / `complete-task`, etc.) will pick up Issue metadata syncing through the existing cascade rules.
