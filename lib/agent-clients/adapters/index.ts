import type { AgentClientAdapter } from '../adapter.ts';
import { claudeCodeAdapter } from './claude-code.ts';
import { codexAdapter } from './codex.ts';
import { antigravityCliAdapter } from './antigravity-cli.ts';
import { opencodeAdapter } from './opencode.ts';
import { traecliAdapter } from './traecli.ts';

const BUILTIN_AGENT_CLIENT_ADAPTERS: readonly AgentClientAdapter[] = Object.freeze([
  claudeCodeAdapter,
  codexAdapter,
  antigravityCliAdapter,
  opencodeAdapter,
  traecliAdapter
]);

export { BUILTIN_AGENT_CLIENT_ADAPTERS };
