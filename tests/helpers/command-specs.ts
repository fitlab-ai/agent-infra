type CommandSpec = {
  usage?: string;
  en?: string;
  zh?: string;
};

const commandSpecs: Record<string, CommandSpec> = {
  "analyze-task": {
    usage: "[task-ref | --task <ref>]",
    en: "Analyze task $ARGUMENTS.",
    zh: "分析任务 $ARGUMENTS。"
  },
  "archive-tasks": {
    usage: "[--days N | --before YYYY-MM-DD | TASK-ID...]",
    en: "Archive completed tasks: $ARGUMENTS",
    zh: "归档已完成任务：$ARGUMENTS"
  },
  "import-codescan": {
    usage: "<alert-number>",
    en: "Import CodeQL alert #$1.",
    zh: "导入 CodeQL 告警 #$1。"
  },
  "import-dependabot": {
    usage: "<alert-number>",
    en: "Import Dependabot alert #$1.",
    zh: "导入 Dependabot 告警 #$1。"
  },
  "import-issue": {
    usage: "<issue-number>",
    en: "Import Issue #$1.",
    zh: "导入 Issue #$1。"
  },
  "block-task": {
    usage: "[task-ref | --task <ref>] [reason]",
    en: "Block task: $ARGUMENTS",
    zh: "阻塞任务：$ARGUMENTS"
  },
  "cancel-task": {
    usage: "[task-ref | --task <ref>] <reason>",
    en: "Cancel task: $ARGUMENTS",
    zh: "取消任务：$ARGUMENTS"
  },
  "check-task": {
    usage: "[task-ref | --task <ref>]",
    en: "Check status of task $ARGUMENTS.",
    zh: "查看任务 $ARGUMENTS 的状态。"
  },
  commit: {
    usage: "[task-ref | --task <ref>]",
    en: "Commit scope: $ARGUMENTS",
    zh: "提交 scope：$ARGUMENTS"
  },
  "close-codescan": {
    usage: "<alert-number>",
    en: "Close CodeQL alert #$1.",
    zh: "关闭 CodeQL 告警 #$1。"
  },
  "close-dependabot": {
    usage: "<alert-number>",
    en: "Close Dependabot alert #$1.",
    zh: "关闭 Dependabot 告警 #$1。"
  },
  "complete-task": {
    usage: "[task-ref | --task <ref>]",
    en: "Complete task $ARGUMENTS.",
    zh: "完成任务 $ARGUMENTS。"
  },
  "complete-manual-validation": {
    usage: "[task-ref | --task <ref>] [pr-ref] <verification-summary>",
    en: "Complete manual validation: $ARGUMENTS",
    zh: "完成人工验证：$ARGUMENTS"
  },
  "create-pr": {
    usage: "[task-ref | --task <ref>] [target-branch]",
    en: "Create PR: $ARGUMENTS",
    zh: "创建 PR：$ARGUMENTS"
  },
  "watch-pr": {
    usage: "[task-ref | --task <ref> | --pr <number>]",
    en: "Watch PR checks: $ARGUMENTS",
    zh: "监控 PR 检查：$ARGUMENTS"
  },
  "create-release-note": {
    usage: "<ver> [prev]",
    en: "Generate release note: $ARGUMENTS",
    zh: "生成发布说明：$ARGUMENTS"
  },
  "create-task": {
    usage: "<description>",
    en: "Task description: $ARGUMENTS",
    zh: "任务描述：$ARGUMENTS"
  },
  "entropy-check": {},
  "init-labels": {},
  "init-milestones": {
    usage: "[--history]",
    en: "Initialize milestones: $ARGUMENTS",
    zh: "初始化里程碑：$ARGUMENTS"
  },
  "code-task": {
    usage: "[task-ref | --task <ref>]",
    en: "Code task $ARGUMENTS.",
    zh: "编码任务 $ARGUMENTS。"
  },
  "plan-task": {
    usage: "[task-ref | --task <ref>]",
    en: "Design plan for task $ARGUMENTS.",
    zh: "为任务 $ARGUMENTS 设计方案。"
  },
  "post-release": {},
  "review-analysis": {
    usage: "[task-ref | --task <ref>]",
    en: "Review analysis for task $ARGUMENTS.",
    zh: "审查任务 $ARGUMENTS 的需求分析。"
  },
  "review-plan": {
    usage: "[task-ref | --task <ref>]",
    en: "Review plan for task $ARGUMENTS.",
    zh: "审查任务 $ARGUMENTS 的技术方案。"
  },
  "refine-title": {
    usage: "<number>",
    en: "Refine title of #$1.",
    zh: "优化 #$1 的标题。"
  },
  release: {
    usage: "<version>",
    en: "Release version $1.",
    zh: "发布版本 $1。"
  },
  "review-code": {
    usage: "[task-ref | --task <ref>]",
    en: "Review code for task $ARGUMENTS.",
    zh: "审查任务 $ARGUMENTS 的代码。"
  },
  "restore-task": {
    usage: "<issue-number> [task-id]",
    en: "Restore task from Issue: $ARGUMENTS",
    zh: "从 Issue 还原任务：$ARGUMENTS"
  },
  test: {},
  "test-integration": {},
  "update-agent-infra": {},
  "upgrade-dependency": {
    usage: "<pkg> <from> <to>",
    en: "Upgrade dependency: $ARGUMENTS",
    zh: "升级依赖：$ARGUMENTS"
  }
};

export {
  commandSpecs
};
