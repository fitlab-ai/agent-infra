import { renderAgentClientInvocation } from '../agent-clients/invocation.ts';
import { getAgentClientAdapter } from '../agent-clients/registry.ts';

export type TuiName = 'claude' | 'codex' | 'antigravity' | 'opencode';

const TUI_NAMES = new Set(['claude', 'codex', 'antigravity', 'opencode']);
const LEGACY_TUI_NAMES: Readonly<Record<string, TuiName>> = { gemini: 'antigravity' };

export type CommandConfig = {
  defaultTui?: unknown;
  skillTuiDefaults?: unknown;
};

function normalizeTuiName(value: unknown): TuiName | undefined {
  if (typeof value !== 'string') return undefined;
  if (TUI_NAMES.has(value)) return value as TuiName;
  return LEGACY_TUI_NAMES[value];
}

export function selectTui(
  skill: string,
  options: { cliTui?: string | null; command?: CommandConfig }
): TuiName {
  const cliTui = normalizeTuiName(options.cliTui);
  if (cliTui) return cliTui;
  const defaults = options.command?.skillTuiDefaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const value = (defaults as Record<string, unknown>)[skill];
    const skillTui = normalizeTuiName(value);
    if (skillTui) return skillTui;
  }
  const defaultTui = normalizeTuiName(options.command?.defaultTui);
  if (defaultTui) return defaultTui;
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
