export type SkillRunSpec =
  | { kind: 'task'; skill: string; role: 'exec'; requiresSandbox: true }
  | { kind: 'create'; skill: 'create-task'; role: 'write'; requiresSandbox: false };

const TASK_SKILLS = new Set([
  'analyze-task',
  'review-analysis',
  'plan-task',
  'review-plan',
  'code-task',
  'review-code',
  'test',
  'test-integration',
  'commit',
  'create-pr',
  'complete-task',
  'watch-pr',
  'block-task',
  'cancel-task'
]);

export function getSkillRunSpec(skill: string): SkillRunSpec | null {
  if (skill === 'create-task') {
    return { kind: 'create', skill: 'create-task', role: 'write', requiresSandbox: false };
  }
  if (TASK_SKILLS.has(skill)) {
    return { kind: 'task', skill, role: 'exec', requiresSandbox: true };
  }
  return null;
}

export function allowedSkillNames(): string[] {
  return ['create-task', ...TASK_SKILLS].sort();
}
