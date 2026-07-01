export type SkillRunSpec =
  | { kind: 'task'; skill: string; role: 'exec'; requiresSandbox: true }
  | { kind: 'create'; skill: 'create-task'; role: 'exec'; requiresSandbox: false };

const TASK_SKILLS = new Set([
  'analyze-task',
  'block-task',
  'cancel-task',
  'code-task',
  'commit',
  'complete-task',
  'create-pr',
  'plan-task',
  'review-analysis',
  'review-code',
  'review-plan',
  'test',
  'test-integration',
  'watch-pr'
]);

export function getSkillRunSpec(skill: string): SkillRunSpec | null {
  if (skill === 'create-task') {
    return { kind: 'create', skill: 'create-task', role: 'exec', requiresSandbox: false };
  }
  if (TASK_SKILLS.has(skill)) {
    return { kind: 'task', skill, role: 'exec', requiresSandbox: true };
  }
  return null;
}

export function allowedSkillNames(): string[] {
  return ['create-task', ...TASK_SKILLS].sort();
}
