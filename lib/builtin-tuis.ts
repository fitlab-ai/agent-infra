const BUILTIN_TUI_IDS = ['claude-code', 'codex', 'gemini-cli', 'opencode'] as const;
type BuiltinTUIId = (typeof BUILTIN_TUI_IDS)[number];

const BUILTIN_TUI_DISPLAY: Record<BuiltinTUIId, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'opencode': 'OpenCode'
};

const BUILTIN_TUI_OWNED_PATH_PREFIXES: Record<BuiltinTUIId, string[]> = {
  'claude-code': ['.claude/'],
  'codex': ['.codex/'],
  'gemini-cli': ['.gemini/'],
  'opencode': ['.opencode/']
};

function isBuiltinTUIId(value: unknown): value is BuiltinTUIId {
  return typeof value === 'string' && (BUILTIN_TUI_IDS as readonly string[]).includes(value);
}

function resolveEnabledTUIs(value: unknown): Set<BuiltinTUIId> {
  // Missing field / null / non-array → full set (backward compat for legacy
  // .airc.json predating the `tuis` field).
  if (!Array.isArray(value)) return new Set(BUILTIN_TUI_IDS);
  // Empty array is a meaningful, user-set value: "no built-in TUI managed".
  // This supports the customTUI-only project layout.
  const set = new Set<BuiltinTUIId>();
  for (const v of value) {
    if (isBuiltinTUIId(v)) set.add(v);
  }
  return set;
}

function isPathOwnedByDisabledTUI(rel: string, enabled: Set<BuiltinTUIId>): boolean {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  for (const tui of BUILTIN_TUI_IDS) {
    if (enabled.has(tui)) continue;
    for (const prefix of BUILTIN_TUI_OWNED_PATH_PREFIXES[tui]) {
      const trimmed = prefix.replace(/\/$/, '');
      if (normalized === trimmed || normalized.startsWith(prefix)) return true;
    }
  }
  return false;
}

export {
  BUILTIN_TUI_IDS,
  BUILTIN_TUI_DISPLAY,
  BUILTIN_TUI_OWNED_PATH_PREFIXES,
  isBuiltinTUIId,
  resolveEnabledTUIs,
  isPathOwnedByDisabledTUI
};
export type { BuiltinTUIId };
