type AgentClientInvocationInput = Readonly<{
  skillName: string;
  projectName?: string;
  args?: readonly string[];
}>;

function renderAgentClientInvocation(
  template: string,
  input: AgentClientInvocationInput
): string {
  let command = template.replaceAll('${skillName}', input.skillName);
  if (input.projectName !== undefined) {
    command = command.replaceAll('${projectName}', input.projectName);
  }
  return [command, ...(input.args ?? [])].join(' ').trim();
}

export { renderAgentClientInvocation };
export type { AgentClientInvocationInput };
