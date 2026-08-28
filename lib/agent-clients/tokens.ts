// Active AI collaborator short tokens — the write-side whitelist for the
// activity log. Migrated from lib/task/commands/log.ts so that the write-side
// internal commands and the rendering side share one definition. Historical
// Gemini tokens remain read-only and are handled by classifyAgent below.
export const KNOWN_AI_AGENTS: ReadonlySet<string> =
  new Set(['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'traecli']);

// Long name -> short name mapping (HD-4, decision A): `claude-code` reuses the
// existing orchestration precedent, and `antigravity-cli` is the active
// client. `gemini-cli` is intentionally not writable.
export const AGENT_LONG_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  'antigravity-cli': 'antigravity'
};

export const AGENT_USAGE_HINT =
  "agent must be a short token (claude/codex/antigravity/opencode/cursor/traecli), " +
  "a long name (claude-code -> claude, antigravity-cli -> antigravity), or 'human'";

// Read-side historical compatibility for activity-log rendering: `gemini` and
// `gemini-cli` stay recognizable when displaying old logs, but are never
// accepted by normalizeAgentToken (write side).
const READ_KNOWN_AI_AGENTS: ReadonlySet<string> =
  new Set([...KNOWN_AI_AGENTS, 'gemini']);

const READ_AGENT_LONG_NAMES: Readonly<Record<string, string>> = {
  ...AGENT_LONG_NAMES,
  'gemini-cli': 'gemini'
};

// Strict write-side validation: the value must be exactly a short token, a
// long name, or 'human'; returns the normalized short token, or null when
// the value is not a recognized agent.
export function normalizeAgentToken(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === 'human') return 'human';
  if (KNOWN_AI_AGENTS.has(trimmed)) return trimmed;
  const short = AGENT_LONG_NAMES[trimmed];
  return short ?? null;
}

// Loose rendering-side classification: tolerates historical parenthetical
// annotations; unknown tokens keep the `human` grouping but get a visible
// signal. The "known AI token" test is `classifyAgent(value).status === 'ai'`.
export function classifyAgent(raw: string):
  { status: 'ai' | 'human' | 'unknown'; display: string } {
  const token = raw.trim().split(/\s+/)[0]?.replace(/\(.*$/, '') ?? '';
  if (token === '') return { status: 'unknown', display: 'human' };
  if (token === 'human') return { status: 'human', display: 'human' };
  if (READ_KNOWN_AI_AGENTS.has(token)) return { status: 'ai', display: token };
  const short = READ_AGENT_LONG_NAMES[token];
  return short ? { status: 'ai', display: short } : { status: 'unknown', display: 'human' };
}
