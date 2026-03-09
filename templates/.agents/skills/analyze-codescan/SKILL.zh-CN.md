---
name: analyze-codescan
description: >
  分析 Code Scanning（CodeQL）告警，评估安全风险，并创建修复任务。
  当用户要求分析 Code Scanning 告警时触发。参数：告警编号。
---

# 分析 Code Scanning 告警

分析指定的 Code Scanning（CodeQL）告警，评估风险，并创建修复任务。

## 执行流程

### 1. 获取告警信息

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts/<alert-number>
```

提取关键信息：
- `number`：告警编号
- `state`：状态（open/dismissed/fixed）
- `rule`：规则信息（id、severity、description、security_severity_level）
- `tool`：扫描工具信息（name、version）
- `most_recent_instance`：位置（path、start_line、end_line）、消息
- `html_url`：GitHub 告警链接

### 2. 创建任务目录和文件

检查是否已存在该告警的任务。如果不存在，创建：

目录：`.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`

任务元数据：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
codescan_alert_number: <alert-number>
severity: <critical/high/medium/low>
rule_id: <rule-id>
tool: <tool-name>
```

### 3. 定位和分析源码

**必要分析**：
- [ ] 读取告警位置的源文件（包含约 20 行上下文）
- [ ] 理解 CodeQL 规则及其检测内容
- [ ] 分析代码为什么触发了此规则
- [ ] 搜索项目中是否有类似模式
- [ ] 评估是否为误报

### 4. 评估安全风险

**必要风险评估**：
- [ ] 外部输入能否到达此代码路径？
- [ ] 是否有输入验证或净化？
- [ ] 潜在的攻击向量是什么？
- [ ] 如果被利用，实际影响是什么？
- [ ] 修复的紧急程度如何？
- [ ] 修复的复杂度如何？

### 5. 输出分析文档

创建 `.ai-workspace/active/{task-id}/analysis.md`：

```markdown
# Code Scanning 告警分析报告

## 告警信息

- **告警编号**：#{alert-number}
- **严重程度**：{critical/high/medium/low}
- **规则 ID**：{rule-id}
- **扫描工具**：{tool-name} {tool-version}
- **状态**：{open/dismissed/fixed}
- **规则描述**：{description}

## 告警详情

### 源码位置
- **文件**：`{file-path}`
- **行号**：L{start-line} - L{end-line}
- **消息**：{告警消息}

### 代码上下文
```{language}
// 包含周围上下文的代码片段
{code-snippet}
```

### 规则说明
{此 CodeQL 规则检测的安全问题是什么}

## 影响评估

### 直接影响的代码
- `{file-path}:{line-number}` - {描述}

### 发现的相似模式
- {其他具有相同代码模式的位置}

## 安全风险评估

### 可利用性
- [ ] 外部输入能否到达此代码路径？
- [ ] 是否有输入验证或过滤？
- [ ] 当前配置是否暴露了漏洞？

**结论**：{高/中/低风险 - 解释原因}

### 攻击向量
{可能的攻击方法}

### 影响程度
{对安全性、数据完整性、可用性的影响}

### 紧急程度
{基于严重程度和可利用性的评估}

## 修复建议

### 推荐修复方式
{具体的代码修改建议}

### 修复复杂度
{难度和工作量评估}

## 参考链接

- GitHub 告警：{html_url}
- CodeQL 规则：https://codeql.github.com/codeql-query-help/{language}/{rule-id}/
```

### 6. 更新任务状态

更新 task.md：`current_step` -> `security-analysis`。

### 7. 告知用户

```
Code Scanning alert #{alert-number} analysis complete.

Alert info:
- Severity: {severity}
- Rule: {rule-id}
- Location: {file-path}:{line-number}

Task info:
- Task ID: {task-id}
- Risk level: {High/Medium/Low}

Next step:
- To fix: execute the plan-task skill with {task-id}
- If false positive: execute the close-codescan skill with {alert-number}
```

## 注意事项

1. **严重程度优先级**：Critical/High -> 立即处理。Medium -> 计划处理。Low -> 可延后。
2. **范围**：专注于分析和风险评估。修复方案设计是 plan-task 技能的职责。
3. **误报检测**：如果代码路径不可达或输入已被净化，建议使用 close-codescan 技能。

## 错误处理

- 告警未找到：提示 "Code Scanning alert #{number} not found"
- 告警已关闭：询问用户是否继续分析
- 网络/权限错误：提示相应信息
