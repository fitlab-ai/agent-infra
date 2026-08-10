# Claude Code - 工具偏好

## 工具使用偏好

| 操作 | 推荐 | 不推荐 |
|------|------|--------|
| 文件搜索 | `Glob` | `find`、`ls` |
| 内容搜索 | `Grep` | `grep`、`rg` |
| 读取文件 | `Read` | `cat`、`head`、`tail` |
| 编辑文件 | `Edit` | `sed`、`awk` |
| 创建文件 | `Write` | `echo >`、`cat <<EOF` |

**Bash 仅用于**：Git 操作、构建/测试、系统信息查询

## Slash Commands

可用命令从 `.claude/commands/` 自动发现。在提示符中输入 `/` 查看完整列表和描述。

任务工作流的典型顺序：
`/create-task` -> `/analyze-task` -> `/plan-task` -> `/code-task` -> `/review-code` -> `/complete-task`
