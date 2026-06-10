# agent-infra - AI 开发指南

本仓库包含 agent-infra 模板和技能仓库，用于多 AI 协作基础设施。

## AI 行为准则（必须遵守）

> 源自 Andrej Karpathy 总结的 4 条 LLM 编程铁律，本项目所有 AI 工具均需遵守。
> 与下方项目规范冲突时，以项目规范为准；其余场景以本节为准。
> 这些准则偏向「稳」而非「快」，琐碎任务可酌情判断。

**SKILL 执行场景的特例**：在执行任一 SKILL 时，**优先遵循 `.agents/rules/no-mid-flow-questions.md`**（默认禁言 + 入口式入参澄清 / 不可逆破坏性操作两类例外）。每次执行 SKILL 前应**先 Read 该规则文件**，以加载完整例外清单和具体约束。这与下文第 1 条「不确定就提问」不矛盾——SKILL 执行有明确的输入、输出和产物，不确定项应按最稳健方案推进并写入产物的「假设」/「未决问题」段落，由用户在审查检查点统一处理，而不是中途打断对话。

### 1. 先思考，再动手（Think Before Coding）

**不要硬猜，不要藏起困惑，把权衡点摆到台面上。**

- 显式声明你的假设；不确定就提问，不要默默猜测。
- 存在多种解释时，列出选项让用户选，不要擅自选定。
- 有更简单的方案就说出来，必要时反推用户的决定。
- 有任何不清楚的地方就停下来，指出困惑点并提问。

### 2. 简洁优先（Simplicity First）

**只写解决当前问题所需的最少代码，不做任何投机性扩展。**

- 不添加未被要求的功能、抽象、配置项。
- 不为单次使用的代码引入抽象层。
- 不为不可能发生的场景写错误处理。
- 写了 200 行但 50 行就够时，重写它。
- 自检："资深工程师会觉得这过度设计吗？"——会，就简化。

### 3. 外科手术式修改（Surgical Changes）

**只动该动的地方；只清理你自己制造的垃圾。**

- 不顺手"优化"邻近代码、注释、格式。
- 不重构没坏的东西。
- 保持现有风格，即使你个人偏好不同。
- 发现无关的死代码——提醒用户，不要擅自删除。
- 因你的改动而产生的孤儿 import/变量/函数，必须由你清理。
- 自检：每一行改动都能直接追溯到用户的请求吗？

### 4. 目标驱动执行（Goal-Driven Execution）

**先定义可验证的成功标准，再循环执行直到达成。**

把任务转成可验证的目标：
- "加校验" → "先写非法输入的失败用例，再让它通过"
- "修 Bug" → "先写复现该 Bug 的用例，再修到通过"
- "重构 X" → "确保重构前后测试都通过"

多步任务先列计划，每一步都附带 verify 检查点：

```
1. [步骤] → verify: [检查项]
2. [步骤] → verify: [检查项]
3. [步骤] → verify: [检查项]
```

强成功标准让你能独立闭环；弱标准（"让它跑起来"）会让用户不断澄清。

---

**这套准则生效的迹象**：diff 中不必要的改动变少；因过度设计被推翻重写的次数变少；澄清问题发生在动手之前而不是踩坑之后。

## 上下文压缩规则（必须遵守）

> 当上下文窗口接近上限、需要对历史消息做有损压缩时，按以下优先级保留 / 丢弃信息。
> 本节约束 LLM 自身的压缩行为，不属于「项目规范」范畴，与上文 AI 行为准则并列、不冲突。

### 压缩时必须保留

- **任务上下文**：当前 `task-id`、关联 Issue/PR 号、`current_step`、最近一次 SKILL 产物文件名（如 `analysis-r2.md`、`plan.md`）。
- **用户偏好与显式 feedback**：被告知「不要这样做」/「一直这样做」的指令、memory 风格的偏好声明。
- **不可逆 / 已发布的副作用**：已执行的破坏性操作（`rm -rf`、`git push --force`、`gh issue edit` 等）、跨轮次的设计决策与裁决理由。
- **未结清的失败信号**：未确认的报错栈、用户尚未回应的提问、被挂起的未决问题。

### 压缩时可有损摘要

- 已成功完成且无后续依赖的工具调用原始输出（可改为「已读取 X / 已写入 Y」摘要）。
- 中间草稿与未被采纳的方案。

### 压缩时的自检

- 压缩后能否独立续写当前 SKILL？若不能，说明保留不足，应回补。
- 是否丢失了任何远端副作用或用户偏好？若是，必须回补。

## 快速开始命令

```bash
# 安装依赖：开发检出后必须先安装真实 npm 依赖
npm install

# 构建项目：编译 TypeScript 源文件到 dist/
npm run build

# 运行测试
npm test

# 代码检查：暂未配置 lint 工具
```

## 编码规范（必须遵守）

- `install.sh` 保持 POSIX sh 兼容，使用 `set -e` 进行错误处理
- 模板文件使用 `{{project}}` 和 `{{org}}` 作为渲染占位符
- Markdown 文件提供双语版本（英文为主 + 中文翻译）

### 版权头更新规则
修改任意带版权头的文件时，必须更新版权年份：
1. 先运行 `date +%Y` 获取当前年份（不要硬编码）
2. 更新格式示例（假设当前年份为 2026）：
   - `2024-2025` -> `2024-2026`
   - `2024` -> `2024-2026`

### 分支命名
使用项目前缀：`agent-infra-feature-xxx`、`agent-infra-bugfix-yyy`

## 项目结构

```
├── bin/                           # CLI 可执行文件
│   └── cli.ts                     # 主 CLI TypeScript 源文件
├── .agents/                       # AI 协作配置与工作区
│   ├── .airc.json                 # 项目配置
│   ├── workspace/                 # 任务工作区
│   ├── skills/                    # 技能仓库
│   └── workflows/                 # 工作流定义
├── templates/                     # 模板源文件（镜像项目目录结构）
├── tests/                         # 测试（Node.js 内置测试运行器）
├── install.sh                     # 引导安装脚本
└── package.json                   # npm 测试脚本定义
```

## 测试要求

- 测试框架：Node.js 内置测试运行器（`node:test`，需 Node.js >= 22）
- 运行命令：`npm test`
- 测试覆盖：模板文件完整性、CLI 初始化流程、占位符渲染验证

### TypeScript 规范

- 项目源码使用 TypeScript 编写，通过 `tsc` 编译到 `dist/` 后发布；运行时要求 Node.js >= 22。开发态可直接 `node --experimental-strip-types ./bin/cli.ts`。
- TypeScript 只使用 erasable syntax：禁止 `enum`、值级 `namespace`、class 参数属性、装饰器、`import =` 和 `export =`。
- ESM 相对 import 在源码中继续写 `.ts` 后缀，`tsc` 通过 `rewriteRelativeImportExtensions` 输出 `.js` 后缀到 `dist/`。

### 测试编写规约

1. **禁止关键词语义断言**：不要通过匹配自然语言措辞来验证 skill 文档内容（如 `assert.match(content, /某段具体描述/)`）。SKILL.md 的文案会频繁调整，绑定措辞的测试极其脆弱。只做结构性检查：frontmatter 合法性、步骤编号连续、引用完整性、体积阈值等。
2. **禁止反向删除断言**：已删除的功能不需要断言其不存在（如 `assert.doesNotMatch(content, /removedField/)`）。删除即彻底删除，不要用测试永久记住一个不再存在的概念，否则会形成无止境的测试债务。
3. **平台守卫只走 helper**：跨平台测试的「整条是否运行」判定必须通过 `tests/helpers.ts` 的 `onPlatforms()` 表达，不得在测试体内写 `if (process.platform === ...) return;` 早返回。同测试体内覆盖多平台行为差异（断言/构造分支）、运行时回退（如 EPERM）属于合法用例。详见 `.agents/rules/cross-platform-tests.md`。

> 正反例（含正向/反向断言取舍）详见 `.agents/rules/testing-discipline.md`。

## 提交与 PR 规范

详见 `.agents/rules/commit-and-pr.md`（提交代码或创建 PR 时按需加载）。

## 安全注意事项

- 不要提交敏感文件：`.env`, `credentials.json`, 密钥等
- 安全问题请按 `SECURITY.md` 指引私下提交（不要公开 Issue）

## 多 AI 协作支持

本项目支持 Claude Code、Codex、Gemini CLI、OpenCode 等多个 AI 工具协同工作。

**协作配置目录**：
- `.agents/` - AI 配置和工作流定义（版本控制）

**协作指南**：`.agents/README.md`

**Skill 维护强制要求**：
- 修改或新增 `.agents/skills/*/SKILL.md` 及其模板前，必须先读取 `.agents/README.md` 中的 “Skill 编写规范” 和 “SKILL.md 体积控制” 章节。

## 语言规范

项目代码层面统一使用**英文**，文档提供**多语言版本**（英文为主版本）。
未在下表中列出的场景，默认使用中文。

| 场景 | 语言 | 说明 |
|------|------|------|
| 代码标识符、JSDoc/TSDoc | 英文 | 代码即文档 |
| CLI 帮助文本、错误信息 | 英文 | 面向所有用户 |
| Git commit message | 英文 | Conventional Commits 祈使语气 |
| 任务标题 | 跟随用户输入语言 | task.md 标题保持用户原文，不套用 Conventional Commits 格式 |
| GitHub Issue/PR 标题 | 英文前缀 + 跟随用户输入语言 | 格式：`type(scope): 中文描述`；type/scope 英文，描述保持原文 |
| 任务工作区产物 | 跟随已部署的技能语言 | `.agents/workspace/` 文件使用 `.airc.json` 选定的 SKILL.md 语言 |
| Activity Log 步骤名 | 英文 | 工具链使用的结构化标识符（如 `**Commit** by`） |
| 项目文档 | 英文（主） + 中文翻译 | 如 `README.md` + `README.zh-CN.md` |
| AI 回复 | 跟随用户输入语言 | 中文问→中文答 |

**提交代码或创建 PR 时**，必须先读取 `.agents/rules/commit-and-pr.md`。
**执行任务工作流命令时**，必须先读取 `.agents/rules/task-management.md`。
