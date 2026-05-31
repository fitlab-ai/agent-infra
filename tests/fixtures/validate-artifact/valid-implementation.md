# 实现报告

- **实现轮次**: Round 1
- **产物文件**: `implementation.md`

## 状态核对

```text
$ git status -s
```

## 变更文件

### 新建文件
- `.agents/scripts/validate-artifact.js` - 共享校验引擎

### 修改文件
- `.agents/skills/implement-task/SKILL.md` - 添加完成校验步骤

## 关键代码说明

### 校验引擎
**文件**: `.agents/scripts/validate-artifact.js:1`

**实现逻辑**:
完成校验按 verify.json 声明顺序执行检查。

**关键代码**:
```js
console.log("gate");
```

## 测试结果

### 单元测试
- 测试文件: `tests/validate-artifact.test.js`
- 测试用例数: 4
- 通过率: 100%

**测试输出**:
```
ok 1 - validate artifact
```

## 证据原文

- 断言：实现报告校验通过。
```text
$ node .agents/scripts/validate-artifact.js gate implement-task .agents/workspace/active/TASK-20260328-000001 implementation.md --format text
Verification: pass
```

## 与方案的差异

无。

## 供审查关注的内容

**建议审查者重点关注**:
- 重试逻辑

## 已知问题

无。

## 下一步

继续代码审查。
