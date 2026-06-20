# CLI help 文案约定

统一 `ai` / `agent-infra` CLI 的 help 文案展示结构、展示名与命令排序，让后续新增子命令自动遵守，避免跨层级再次漂移。新增或调整 CLI help 文案前先读取本文件。

## 适用范围

- **展示名 `ai`**：适用于**所有**面向用户的 help / usage / 交互横幅文案——顶层、命名空间级，以及 `merge` / `init` / `update` 等叶子命令的单行 usage 与启动横幅，统一用 `ai`。唯一例外：顶层 help 首行保留品牌 + 版本行 `agent-infra ${VERSION}`；包名 / 安装命令 / 仓库 URL 中的 `@fitlab-ai/agent-infra` 保持原样。
- **结构与排序**（`Usage:` + `Commands:` 结构、命令按字母序）：仅适用于带 `Commands:` 子清单的层级——顶层 help（`bin/cli.ts`）与命名空间级 help（如 `ai sandbox` / `ai task`）。叶子命令只有单行 usage，无需 `Commands:` 结构。

## 展示名

- help 文案中的命令展示名统一用 **`ai`**（推荐简写，`package.json` 的 `bin` 同时注册 `ai` 与 `agent-infra`）。
- 顶层 help 首行保留品牌 + 版本行 `agent-infra ${VERSION} - bootstrap ...`（这是品牌与版本标识，多处测试锚定它）。
- 安装方式、包名、仓库 URL 中的 `@fitlab-ai/agent-infra` 等保持原样（是包名而非命令展示名）。

## 列表结构

命名空间级与顶层 help 统一为：

```
Usage: ai <ns> <command> [options]

Commands:
  <command>  <两空格起对齐的描述>
  ...

Run 'ai <ns> <command> --help' for details.
```

- `Commands:` 块用裸命令名（不重复二进制名），两空格缩进，描述按最长命令名对齐。
- 命名空间级 help 末尾加 `Run 'ai <ns> <command> --help' for details.` footer。
- 顶层 help 无统一子命令 `--help` 约定，故不强制加该 footer；如有 `Examples:` 段，命令展示名同样用 `ai`。

## 排序

命令清单、`Examples`、描述中内嵌的命令枚举，一律按**命令首 token 的字母升序**排列：

- 多 token 命令（如 `vm status|start|stop`）按首 token（`vm`）排序。
- 带尖括号 / 方括号参数的命令按命令名（参数前的裸词）排序。
- 大小写不敏感。

## 新增子命令检查清单

新增一个子命令时：

1. 把命令插入 `Commands:` 的字母序正确位置。
2. 如有示例，插入 `Examples:` 的字母序位置。
3. 若顶层 `task` / `sandbox` 等描述中有内嵌命令枚举，同步更新其字母序。
4. 同步对应 help 测试的**结构性**断言（命令是否出现、`Usage:` / `Commands:` 头是否存在），不要绑定整句文案（见 [`testing-discipline.md`](testing-discipline.md)）。
