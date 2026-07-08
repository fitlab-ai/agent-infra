# 熵减审查报告

- **报告文件**：`.agents/workspace/logs/entropy-check/entropy-check-YYYYMMDD-HHMMSS.md`
- **执行者**：{agent}
- **执行时间**：{timestamp}

## 状态核对

```text
$ git status -s
{output}

$ git branch --show-current
{output}

$ date "+%Y-%m-%d %H:%M:%S%:z"
{output}
```

## 审查范围

- {file-or-area} - {why it was inspected}

## 发现摘要

| 严重度 | 数量 | 说明 |
|---|---:|---|
| release-blocking | {n} | 发版前必须处理或人工裁定 |
| major | {n} | 建议尽快处理 |
| minor | {n} | 可排期处理 |
| info | {n} | 观察项 |

## 发现详情

### EC-1：{title}

- **严重度**：{release-blocking | major | minor | info}
- **问题**：{what is wrong}
- **证据**：
  ```text
  $ {command}
  {output}
  ```
- **影响**：{impact}
- **建议**：{recommendation}
- **是否需要人工裁决**：{yes/no}

## 人工裁决待办

### HD-1：{title} [needs-human-decision]

- **背景**：{context}
- **选项**：{options}
- **影响**：{impact}
- **建议**：{recommendation}

## 后续任务建议

- {suggested follow-up task}

## 假设

- {assumption}

## 未决问题

- {open question}
