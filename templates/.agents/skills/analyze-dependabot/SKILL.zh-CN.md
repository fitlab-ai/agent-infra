---
name: analyze-dependabot
description: >
  分析 Dependabot 安全告警，评估安全风险，并创建修复任务。
  当用户要求分析 Dependabot 告警时触发。参数：告警编号。
---

# 分析 Dependabot 安全告警

分析指定的 Dependabot 安全告警，评估风险，并创建修复任务。

## 执行流程

### 1. 获取告警信息

```bash
gh api repos/{owner}/{repo}/dependabot/alerts/<alert-number>
```

提取关键信息：
- `number`：告警编号
- `state`：状态（open/dismissed/fixed）
- `security_advisory`：安全公告详情（ghsa_id、cve_id、severity、summary、description）
- `dependency`：受影响的依赖（包名、生态系统、清单路径）
- `security_vulnerability`：受影响版本范围、首个修复版本

### 2. 创建任务目录和文件

检查 `.ai-workspace/active/` 中是否已存在该告警的任务。
- 如果找到，询问用户是否重新分析
- 如果未找到，创建新任务

创建目录：`.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`

任务元数据需包含：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
security_alert_number: <alert-number>
severity: <critical/high/medium/low>
cve_id: <CVE-ID>
ghsa_id: <GHSA-ID>
```

### 3. 分析受影响范围

**必要分析**：
- [ ] 识别受影响的依赖包和版本
- [ ] 搜索项目中使用该依赖的所有位置
- [ ] 检查依赖文件（pom.xml、package.json、requirements.txt 等）
- [ ] 判断是否直接使用了漏洞代码路径
- [ ] 识别依赖类型（直接依赖 vs 传递依赖）
- [ ] 定位受影响的代码模块和文件

### 4. 评估安全风险

**必要风险评估**：
- [ ] 评估漏洞的实际可利用性（能否触发漏洞？）
- [ ] 分析漏洞触发条件和场景
- [ ] 评估对系统安全性、数据完整性、可用性的影响
- [ ] 识别潜在的攻击向量
- [ ] 确定修复的紧急程度
- [ ] 检查是否有已知的在野利用

### 5. 输出分析文档

创建 `.ai-workspace/active/{task-id}/analysis.md`：

```markdown
# 安全告警分析报告

## 告警信息

- **告警编号**：#{alert-number}
- **严重程度**：{critical/high/medium/low}
- **GHSA ID**：{ghsa-id}
- **CVE ID**：{cve-id}
- **状态**：{open/dismissed/fixed}
- **摘要**：{描述}

## 漏洞详情

### 受影响的依赖
- **包名**：{package-name}
- **生态系统**：{maven/pip/npm/...}
- **当前版本**：{current-version}
- **受影响版本范围**：{vulnerable-range}
- **首个修复版本**：{patched-version}

### 依赖使用情况
- **清单路径**：`{manifest-path}`
- **依赖类型**：{直接/传递}
- **使用位置**：
  - `{module-1}` - {描述}
  - `{module-2}` - {描述}

## 影响评估

### 直接影响的代码
- `{file-path}:{line-number}` - {描述}

### 间接影响的功能
- {受影响的功能模块}

## 安全风险评估

### 可利用性
- [ ] 漏洞代码路径是否被直接使用？
- [ ] 是否有外部输入可以触发漏洞？
- [ ] 当前配置是否暴露了漏洞？

**结论**：{高/中/低风险 - 解释原因}

### 触发条件
{漏洞如何被触发的详细描述}

### 影响程度
{对安全性、数据完整性、可用性的影响评估}

### 紧急程度
{基于严重程度和可利用性，修复的紧急程度}

## 参考链接

- GHSA 公告：https://github.com/advisories/{ghsa-id}
- CVE 详情：https://cve.mitre.org/cgi-bin/cvename.cgi?name={cve-id}
```

### 6. 更新任务状态

更新 task.md：`current_step` -> `security-analysis`。

### 7. 告知用户

```
Security alert #{alert-number} analysis complete.

Vulnerability info:
- Severity: {severity}
- CVE/GHSA: {cve-id} / {ghsa-id}
- Affected package: {package-name}

Task info:
- Task ID: {task-id}
- Risk level: {High/Medium/Low}

Output files:
- Task: .ai-workspace/active/{task-id}/task.md
- Analysis: .ai-workspace/active/{task-id}/analysis.md

Next step:
- To fix: execute the plan-task skill with {task-id}
- If not applicable: execute the close-dependabot skill with {alert-number}
```

## 注意事项

1. **严重程度优先级**：Critical/High -> 立即处理。Medium -> 计划处理。Low -> 可延后。
2. **范围**：专注于分析和风险评估。不设计修复方案（那是 plan-task 技能的职责）。
3. **误报检测**：如果漏洞代码路径未被使用，记录此情况并建议使用 close-dependabot 技能。

## 错误处理

- 告警未找到：提示 "Security alert #{number} not found"
- 告警已关闭：询问用户是否继续分析
- 网络/权限错误：提示相应信息
