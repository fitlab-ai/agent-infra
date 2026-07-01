import { VERSION } from '../version.ts';
import { getSkillRunSpec } from '../run/skills.ts';
import type { CommandRole } from './auth.ts';

export type CommandPlan =
  | { kind: 'ignore' }
  | { kind: 'error'; message: string }
  | { kind: 'builtin'; name: 'ping' | 'help' | 'version'; role: 'read'; args: string[] }
  | { kind: 'ai'; role: CommandRole; argv: string[] };

const TASK_READ = new Set(['ls', 'list', 'status', 'show', 'log', 'decisions']);
const SANDBOX_READ = new Set(['ls', 'list', 'show']);
const SANDBOX_WRITE = new Set(['create', 'start']);

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function taskSubcommand(subcommand: string): string {
  return subcommand === 'list' ? 'ls' : subcommand;
}

export function commandHelp(): string {
  return [
    `agent-infra ${VERSION}`,
    'Built-ins: /help, /ping, /version',
    'Read: /sandbox ls|show|vm status, /task decisions|log|ls|show|status',
    'Write: /sandbox create|start',
    'Exec: /decide <task-ref> <HD-id> <decision>, /run create-task <description>, /run <skill> <task-ref> ...'
  ].join('\n');
}

export function parseCommand(text: string): CommandPlan {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'ignore' };
  const words = splitWords(trimmed);
  const [command = '', subcommand = '', ...rest] = words;

  if (command === '/help') return { kind: 'builtin', name: 'help', role: 'read', args: rest };
  if (command === '/ping') return { kind: 'builtin', name: 'ping', role: 'read', args: rest };
  if (command === '/version') return { kind: 'builtin', name: 'version', role: 'read', args: rest };

  if (command === '/decide') {
    return { kind: 'ai', role: 'exec', argv: ['decide', subcommand, ...rest] };
  }

  if (command === '/task') {
    if (!TASK_READ.has(subcommand)) return { kind: 'error', message: 'Unknown /task command' };
    return { kind: 'ai', role: 'read', argv: ['task', taskSubcommand(subcommand), ...rest] };
  }

  if (command === '/sandbox') {
    if (subcommand === 'vm') {
      if (rest[0] !== 'status') return { kind: 'error', message: 'Only /sandbox vm status is allowed' };
      return { kind: 'ai', role: 'read', argv: ['sandbox', 'vm', 'status'] };
    }
    if (SANDBOX_READ.has(subcommand)) {
      return { kind: 'ai', role: 'read', argv: ['sandbox', taskSubcommand(subcommand), ...rest] };
    }
    if (SANDBOX_WRITE.has(subcommand)) {
      return { kind: 'ai', role: 'write', argv: ['sandbox', subcommand, ...rest] };
    }
    if (subcommand === 'rm') {
      return {
        kind: 'error',
        message: '/sandbox rm is not available from IM because it requires interactive confirmation'
      };
    }
    return { kind: 'error', message: 'Unknown /sandbox command' };
  }

  if (command === '/run') {
    const spec = getSkillRunSpec(subcommand);
    if (!spec) return { kind: 'error', message: `Unknown skill: ${subcommand}` };
    return { kind: 'ai', role: spec.role, argv: ['run', subcommand, ...rest] };
  }

  return { kind: 'error', message: `Unknown command: ${command}` };
}
