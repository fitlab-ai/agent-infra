---
name: upgrade-dependency
description: "升级项目依赖到新版本并验证"
---

# 升级依赖

将依赖包升级到指定版本，并进行构建和测试验证。

<!-- TODO: 根据你的项目包管理器调整以下命令 -->

## 执行流程

### 1. 解析参数

从参数中提取：包名、原版本、新版本。

### 2. 查找依赖位置

在依赖文件中搜索目标包：
- `package.json`（Node.js）
- `pom.xml`（Maven）
- `requirements.txt` / `pyproject.toml`（Python）
- `go.mod`（Go）
- 其他项目特定的依赖文件

### 3. 更新版本

在依赖文件中更新版本号。

### 4. 安装依赖

<!-- TODO: 替换为你的项目安装命令 -->
```bash
# npm install          (Node.js)
# mvn clean install    (Maven)
# pip install -r requirements.txt  (Python)
# go mod tidy          (Go)
```

### 5. 验证构建

<!-- TODO: 替换为你的项目构建命令 -->
```bash
# npm run build        (Node.js)
# mvn compile          (Maven)
# make build           (通用)
```

### 6. 运行测试

执行项目的测试命令。参考 test 技能获取项目特定的测试命令。

### 7. 输出结果

报告：
- 修改的文件
- 构建状态（通过/失败）
- 测试状态（通过/失败）
- 发现的任何弃用警告或破坏性变更

建议下一步：

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTools`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

```
下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/{{project}}:commit
  - Codex CLI：$commit
```

## 注意事项

1. **禁止自动提交**：不要自动提交变更
2. **主版本升级**：警告潜在的破坏性变更
3. **测试失败**：报告失败详情并等待用户决定
4. **锁文件**：如果项目使用锁文件（package-lock.json、yarn.lock 等），确保一并更新
5. **传递依赖**：注意升级是否影响传递依赖

## 错误处理

- 包未找到：提示 "Package {name} not found in dependency files"
- 构建失败：输出错误并建议检查破坏性变更
- 测试失败：输出测试错误并建议查看迁移指南
