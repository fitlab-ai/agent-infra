# 通用规则 - 测试编写纪律

> 本文件承载测试编写的正反例细节；AGENTS.md（及 CLAUDE.md）的「测试编写规约」只保留精简条目并指向此处，避免高频上下文膨胀。

## 背景

曾有一批脆弱的关键词匹配断言需要整体替换为结构性检查（frontmatter 合法性、步骤编号、引用完整性、zh-CN 变体、体积阈值）。教训：绑定自然语言措辞、或用断言"记住一个已删除概念"，都会形成无止境的测试债务。

## 正反例：正向断言已覆盖时，不应再加反向断言

当正向断言已覆盖期望行为，就不要再为"反面不应出现"补一条反向断言。

❌ 反例：
```ts
assert.match(content, /^name: code-task$/m);         // 正向已覆盖期望值
assert.doesNotMatch(content, /^name: wrong-name$/m); // 多余：永久记住一个不该出现的值
```

✅ 正例：
```ts
assert.match(content, /^name: code-task$/m);         // 正向断言已足够
```

正向断言通过即证明值正确；额外的反向断言不增加保护，只增加维护成本，并会在功能删除后退化为"测试永久记住一个不再存在的概念"。

## RED-GREEN-REFACTOR 节奏

实现阶段先把需求转成可观察行为的测试，再写代码：

1. **RED**：先写一个能复现需求或缺陷的失败用例，并确认它确实失败。测试应覆盖业务行为、输入输出或用户可见结果，不绑定内部实现细节。
2. **GREEN**：写最少代码让失败用例通过。不要顺手扩展未被测试和未被需求覆盖的行为。
3. **REFACTOR**：在测试全绿后整理命名、结构或重复代码；重构前后保持同一组测试通过。

这与 AGENTS.md 的「目标驱动执行」一致：先定义可验证成功标准，再让实现满足它。

## 测试反模式

- **mock 过度**：只在网络、文件系统、时间、随机数等真实边界打桩；不要 mock 被测对象自身逻辑，否则测试只验证 mock 是否按预设运行。
- **测试实现细节**：优先断言公开接口、产物、状态变化或错误结果；避免断言私有函数、内部调用顺序、临时数据结构。
- **断言不充分**：断言必须锁定具体期望值；不要用"只要不抛异常""结果存在即可"替代对关键字段、数量和边界的验证。

## 覆盖率定位（信息层）

> CI 中通过 `node --test --experimental-test-coverage` 输出覆盖率，仅作为"哪些文件被测试薄弱"的提示，**不作为 merge gate**。

### 本地运行

```bash
npm run test:coverage
```

stdout 末尾会打印按文件粒度的行 / 分支 / 函数覆盖率以及未覆盖行号。

### CI 展示

`.github/workflows/unit-tests.yml` 在 ubuntu-latest 分片上把覆盖率块写入 GitHub Actions 的 step summary（PR Checks 页可见）。Windows / macOS 分片不重复输出。

README 顶部的 Codecov 徽章由 `.github/workflows/unit-tests.yml` 在 ubuntu-latest 分片上传 `coverage.lcov` 后由 Codecov 生成。

### 边界

- **不设置百分比阈值**：`--test-coverage-lines/branches/functions` 等阈值参数禁止加入；Goodhart's law 提醒我们一旦把覆盖率作为指标，开发者会写"覆盖率友好但行为弱"的测试。
- **第三方服务仅用于徽章**：已接入 Codecov 托管 README 覆盖率徽章，但通过根 `codecov.yml` 显式关闭其 project/patch status check 与 PR 评论——Codecov 在本项目只展示数字，不参与 merge 决策。不接入 coveralls 等其他服务。
- **不区分 tier**：当前只对 full `test` tier 输出覆盖率；smoke / core tier 的覆盖率没有独立价值。
- **不阻塞 PR**：CI 步骤 `continue-on-error: true`，即便覆盖率采集失败也不影响 merge。

### 新测试该放哪一层

测试文件放入哪一层决定它会被哪些 npm script 自动执行：

- `tests/unit/<module>/`：快速、结构性或纯函数类测试；不启动真实 CLI 子进程，不依赖外部工具，适合 `test:smoke`。
- `tests/integration/<module>/`：会组合多个模块、运行 CLI 子进程、触达临时文件系统或验证模板同步流程，但仍应保持稳定和相对快速，适合 `test:core`。
- `tests/e2e/<module>/`：较慢的契约、平台同步、打包产物、跨进程或端到端流程测试，只在完整 `npm test` 中运行。

模块继续作为第二级目录（如 `cli`、`core`、`scripts`、`templates`）。共享 helper 和 fixtures 保持在 `tests/helpers/`、`tests/helpers.ts`、`tests/fixtures/`，不要放入任一 tier。

### 与"测试 tier 覆盖"的关系

注意区分两个概念：

- **测试 tier 覆盖**（`tests/unit/core/test-tier-coverage.test.ts` 校验测试文件目录归属与 npm script tier 映射）：管的是"哪些测试文件被纳入哪一 tier"，与代码行覆盖率正交。
- **代码行覆盖率**（本节）：管的是"业务源码哪些行被测试触达"。

两者目的不同，不要相互替代。
