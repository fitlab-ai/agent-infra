import { listEnabledAgentClientAdapters } from './registry.ts';
import type { CustomTUI } from './custom-tuis.ts';
import type { AgentClientId, AgentClientState } from './types.ts';

type NextStepCommand = Readonly<{
  source: 'builtin' | 'custom';
  clientId?: AgentClientId;
  displayName: string;
  command: string;
}>;

type RenderNextStepsInput = Readonly<{
  projectName: string;
  state: AgentClientState;
  customTUIs: readonly CustomTUI[];
  skillName: string;
  taskRef?: string;
}>;

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_TASK_REF = /^(?:\d+|TASK-\d{8}-\d{6})$/;

function requireSafeName(value: string, field: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
}

function renderInvocation(
  invocation: string,
  projectName: string,
  skillName: string,
  taskRef: string | undefined
): string {
  const command = invocation
    .replaceAll('${projectName}', projectName)
    .replaceAll('${skillName}', skillName);
  return taskRef === undefined ? command : `${command} ${taskRef}`;
}

function renderNextStepCommands(
  input: RenderNextStepsInput
): readonly NextStepCommand[] {
  requireSafeName(input.projectName, 'project name');
  requireSafeName(input.skillName, 'skill name');
  if (input.taskRef !== undefined && !SAFE_TASK_REF.test(input.taskRef)) {
    throw new Error('Invalid task ref');
  }

  const builtins = listEnabledAgentClientAdapters(input.state).map(
    (adapter): NextStepCommand => Object.freeze({
      source: 'builtin',
      clientId: adapter.id,
      displayName: adapter.displayName,
      command: renderInvocation(
        adapter.invocation,
        input.projectName,
        input.skillName,
        input.taskRef
      )
    })
  );
  const custom = input.customTUIs.map(
    (tool): NextStepCommand => Object.freeze({
      source: 'custom',
      displayName: tool.name,
      command: renderInvocation(
        tool.invocation,
        input.projectName,
        input.skillName,
        input.taskRef
      )
    })
  );
  return Object.freeze([...builtins, ...custom]);
}

export { renderNextStepCommands };
export type { NextStepCommand, RenderNextStepsInput };
