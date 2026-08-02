import { listEnabledAgentClientAdapters } from './registry.ts';
import { renderAgentClientInvocation } from './invocation.ts';
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
      command: renderAgentClientInvocation(
        adapter.invocation,
        {
          projectName: input.projectName,
          skillName: input.skillName,
          args: input.taskRef === undefined ? [] : [input.taskRef]
        }
      )
    })
  );
  const custom = input.customTUIs.map(
    (tool): NextStepCommand => Object.freeze({
      source: 'custom',
      displayName: tool.name,
      command: renderAgentClientInvocation(
        tool.invocation,
        {
          projectName: input.projectName,
          skillName: input.skillName,
          args: input.taskRef === undefined ? [] : [input.taskRef]
        }
      )
    })
  );
  return Object.freeze([...builtins, ...custom]);
}

export { renderNextStepCommands };
export type { NextStepCommand, RenderNextStepsInput };
