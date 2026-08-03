// Standard AI collaborator short tokens — the single source of truth for the
// activity log. Migrated from lib/task/commands/log.ts so that the write-side
// internal commands and the rendering side share one definition.
export const KNOWN_AI_AGENTS: ReadonlySet<string> =
  new Set(['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'cursor']);

// Long name -> short name mapping (HD-4, decision A): `claude-code` reuses the
// existing orchestration precedent, `gemini-cli` is historical, and
// `antigravity-cli` is the active client.
export const AGENT_LONG_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
  'antigravity-cli': 'antigravity'
};

export const AGENT_USAGE_HINT =
  "agent must be a short token (claude/codex/gemini/antigravity/opencode/cursor), " +
  "a long name (claude-code -> claude, gemini-cli -> gemini, antigravity-cli -> antigravity), or 'human'";

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
  const normalized = normalizeAgentToken(token);
  return normalized ? { status: 'ai', display: normalized } : { status: 'unknown', display: 'human' };
}
