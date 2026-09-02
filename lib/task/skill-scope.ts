const TASK_SCOPE_SKILLS: ReadonlySet<string> = new Set([
  'analyze-task',
  'block-task',
  'cancel-task',
  'check-task',
  'code-task',
  'commit',
  'complete-manual-validation',
  'complete-task',
  'create-pr',
  'plan-task',
  'review-analysis',
  'review-code',
  'review-plan',
  'run-manual-validation',
  'run-task',
  'watch-pr'
]);

function isTaskScopeSkill(skillName: string): boolean {
  return TASK_SCOPE_SKILLS.has(skillName);
}

export { TASK_SCOPE_SKILLS, isTaskScopeSkill };
