export const TASK_WORKFLOW_COMMANDS = Object.freeze({
  'artifact-inspect': ['task-artifact', 'inspect'],
  'artifact-init': ['task-artifact', 'init'],
  'artifact-repair': ['task-artifact', 'repair'],
  'artifact-finalize-local': ['task-artifact', 'finalize-local'],
  'review-finalize-summary': ['task-review', 'finalize-summary'],
  event: ['task-event', null],
  'ledger-finding-response': ['task-ledger', 'finding-respond'],
  'ledger-finding-review': ['task-ledger', 'finding-review'],
  'ledger-finding-upsert': ['task-ledger', 'finding-upsert'],
  'decision-next-id': ['task-ledger', 'decision-next-id'],
  'decision-upsert': ['task-ledger', 'decision-upsert'],
  'invalidation-reconcile': ['task-invalidation', 'reconcile'],
  'warning-add': ['task-warning', 'add']
} as const);
export type TaskWorkflowOperation = keyof typeof TASK_WORKFLOW_COMMANDS;
export const TASK_WORKFLOW_OPERATIONS = Object.freeze(Object.keys(TASK_WORKFLOW_COMMANDS) as TaskWorkflowOperation[]);
export type WorkflowCommand = typeof TASK_WORKFLOW_COMMANDS[TaskWorkflowOperation][0];
