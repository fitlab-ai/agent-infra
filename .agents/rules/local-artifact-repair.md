# 通用规则 - 当前本地产物重验

本规则适用于生命周期产物的当前校验。finalizer 直接读取正式 artifact，不创建 recovery candidate、generation、baseline、journal 或 recovery identity。

## 当前校验

1. completed event 前运行对应 finalizer，并使用该次返回的 `artifactSha256` 和 `semanticDigest`。
2. 失败时读取诊断，对正式 artifact 作一次最小修正，再以相同 task、family/stage 和 artifact 重跑。
3. 每次重跑重新校验结构、资格、上游关系、账本和当前摘要；没有进展或无法安全修正时停止，不发布 completed。

## 编辑边界

模型只能修改当前 skill 声明的 artifact。

## 完成事件

completed event 仍校验当前 digest、round、输入和外部事实。

## 共享入口

```text
agent-infra-internal task-artifact {task-id} finalize-local --family code --artifact {code-artifact}
```

## 停止条件

无法安全修正或没有进展时停止。
