# Release 命令

当前代码平台未提供发布说明 adapter。

本地 `agent-infra-internal platform-release-notes stage --notes-file "{notes-file}"` 仍可规范化工作树外文件并返回摘要。调用 `context` 会返回结构化的 `PLATFORM_RELEASE_NOTES_UNSUPPORTED` no-op，不得探测其他平台 client；提供 adapter 前，带 `--expected-sha256` 的 publish 同样保持 no-op。
