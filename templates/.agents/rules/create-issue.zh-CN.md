# Issue 创建

当前代码平台未提供 Issue 创建规则。

`create-task` 在本平台上会跳过级联创建 Issue 步骤；本地 `task.md` 仍然是有效产物。如果将来需要把任务绑定到一个 Issue，可手动在 `task.md` 中写入 `issue_number`，后续技能（`commit` / `refine-task` / `complete-task` 等）会按既有的级联同步规则自动接管 Issue 元数据更新。
