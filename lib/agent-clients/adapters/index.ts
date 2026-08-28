import { AGENT_CLIENT_IDS } from '../types.ts';
import type { AgentClientAdapter } from '../adapter.ts';
import { claudeCodeAdapter } from './claude-code.ts';
import { codexAdapter } from './codex.ts';
import { antigravityCliAdapter } from './antigravity-cli.ts';
import { opencodeAdapter } from './opencode.ts';
import { traecliAdapter } from './traecli.ts';

const adaptersById = new Map(
  [
    claudeCodeAdapter,
    codexAdapter,
    antigravityCliAdapter,
    opencodeAdapter,
    traecliAdapter
  ].map((adapter) => [adapter.id, adapter])
);

const BUILTIN_AGENT_CLIENT_ADAPTERS: readonly AgentClientAdapter[] = Object.freeze(
  AGENT_CLIENT_IDS.map((id) => {
    const adapter = adaptersById.get(id);
    if (!adapter) {
      throw new Error(`Missing built-in Agent Client adapter '${id}'`);
    }
    return adapter;
  })
);

export { BUILTIN_AGENT_CLIENT_ADAPTERS };
