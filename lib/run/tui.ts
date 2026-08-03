import { renderAgentClientInvocation } from '../agent-clients/invocation.ts';
import { getAgentClientAdapter } from '../agent-clients/registry.ts';

export type TuiName = 'claude' | 'codex' | 'antigravity' | 'opencode';

const TUI_NAMES = new Set(['claude', 'codex', 'antigravity', 'opencode']);

export type CommandConfig = {
  defaultTui?: unknown;
  skillTuiDefaults?: unknown;
};

function isTuiName(value: unknown): value is TuiName {
  return typeof value === 'string' && TUI_NAMES.has(value);
}

export function selectTui(
  skill: string,
  options: { cliTui?: string | null; command?: CommandConfig }
): TuiName {
  if (isTuiName(options.cliTui)) return options.cliTui;
  const defaults = options.command?.skillTuiDefaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const value = (defaults as Record<string, unknown>)[skill];
    if (isTuiName(value)) return value;
  }
  if (isTuiName(options.command?.defaultTui)) return options.command.defaultTui;
  return 'codex';
}

export function renderPrompt(params: { tui: TuiName; skill: string; args: string[] }): string {
  const suffix = [params.skill, ...params.args].join(' ').trim();
  if (params.tui === 'codex') {
    return renderAgentClientInvocation(getAgentClientAdapter('codex').invocation, {
      skillName: params.skill,
      args: params.args
    });
  }
  return `/${suffix}`;
}

export function buildTuiCommand(tui: TuiName, prompt: string): [string, string[]] {
  if (tui === 'claude') return ['claude', ['--dangerously-skip-permissions', '--print', prompt]];
  if (tui === 'antigravity') return ['agy', ['--dangerously-skip-permissions', '--print', prompt]];
  if (tui === 'opencode') return ['opencode', ['run', '--dangerously-skip-permissions', prompt]];
  return ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]];
}
