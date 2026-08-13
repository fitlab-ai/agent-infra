import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CodexLifecycleEvent } from './evidence.ts';

type JsonObject = Record<string, unknown>;
type ThreadResolution = Readonly<{
  thread: Extract<CodexLifecycleEvent, { type: 'app-thread' }>;
  settings: Extract<CodexLifecycleEvent, { type: 'app-settings' }>;
}>;

type AppServerTransportOptions = Readonly<{
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}>;

type CodexRuntimeIdentity = Readonly<{
  sessionId: string;
  turnId: string;
  toolUseId: string;
}>;

const LIFECYCLE_HOOKS = Object.freeze([
  Object.freeze({ event: 'PreToolUse', matcher: '^Agent$', phase: 'pre-tool' }),
  Object.freeze({ event: 'PostToolUse', matcher: '^Agent$', phase: 'post-tool' }),
  Object.freeze({ event: 'SubagentStart', matcher: '^agent-infra-lifecycle-(executor|reviewer)$', phase: 'subagent-start' }),
  Object.freeze({ event: 'SubagentStop', matcher: '^agent-infra-lifecycle-(executor|reviewer)$', phase: 'subagent-stop' })
]);

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function validateCodexLifecycleHookConfig(value: unknown): void {
  const hooks = object(object(value)?.hooks);
  const valid = hooks && LIFECYCLE_HOOKS.every(({ event, matcher, phase }) => {
    const entries = hooks[event];
    if (!Array.isArray(entries)) return false;
    return entries.some((entryValue) => {
      const entry = object(entryValue);
      if (entry?.matcher !== matcher || !Array.isArray(entry.hooks)) return false;
      return entry.hooks.some((hookValue) => {
        const hook = object(hookValue);
        return hook?.type === 'command'
          && hook.timeout === 5
          && hook.command === `node "$(git rev-parse --show-toplevel)/.agents/hooks/lifecycle-delegation.js" --client codex --event ${phase}`;
      });
    });
  });
  if (!valid) throw new Error('CODEX_PREFLIGHT_HOOKS_INVALID: lifecycle hooks are invalid');
}

function hasCodexRuntimeLiveness(
  runtimeRoot: string,
  hookDefinitionHash: string,
  identity?: CodexRuntimeIdentity
): boolean {
  if (!identity || !fs.existsSync(runtimeRoot)) return false;
  return fs.readdirSync(runtimeRoot)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .some((name) => {
      try {
        const record = object(JSON.parse(fs.readFileSync(path.join(runtimeRoot, name), 'utf8')));
        const state = object(record?.state);
        const spawnEvent = object(state?.spawn);
        return !['invalid', 'expired'].includes(String(state?.status))
          && spawnEvent?.hookDefinitionHash === hookDefinitionHash
          && spawnEvent.sessionId === identity.sessionId
          && spawnEvent.turnId === identity.turnId
          && spawnEvent.toolUseId === identity.toolUseId;
      } catch {
        return false;
      }
    });
}

function parseCodexThreadResolution(value: unknown): ThreadResolution {
  const root = object(value);
  const thread = object(root?.thread);
  const source = object(thread?.source);
  const subAgent = object(source?.subAgent);
  const threadSpawn = object(subAgent?.thread_spawn);
  const childThreadId = nonEmpty(thread?.id);
  const parentThreadId = nonEmpty(thread?.parentThreadId);
  const sourceParentThreadId = nonEmpty(threadSpawn?.parent_thread_id);
  const model = nonEmpty(root?.model);
  const reasoningEffort = nonEmpty(root?.reasoningEffort ?? object(root?.settings)?.effort);
  const forkedFromId = thread?.forkedFromId;
  if (
    !childThreadId
    || !parentThreadId
    || !sourceParentThreadId
    || !model
    || !reasoningEffort
    || (forkedFromId !== null && typeof forkedFromId !== 'string')
  ) {
    throw new Error('Codex App Server thread resolution is invalid');
  }
  return Object.freeze({
    thread: Object.freeze({
      type: 'app-thread',
      childThreadId,
      parentThreadId,
      forkedFromId,
      sourceParentThreadId
    }),
    settings: Object.freeze({
      type: 'app-settings',
      childThreadId,
      model,
      reasoningEffort
    })
  });
}

function parseCodexTurnCompleted(value: unknown): Extract<CodexLifecycleEvent, { type: 'app-terminal' }> {
  const root = object(value);
  const turn = object(root?.turn);
  const childThreadId = nonEmpty(root?.threadId);
  const turnId = nonEmpty(turn?.id);
  const status = turn?.status;
  if (!childThreadId || !turnId || !['completed', 'interrupted', 'failed'].includes(String(status))) {
    throw new Error('Codex App Server turn completion is invalid');
  }
  return Object.freeze({
    type: 'app-terminal',
    childThreadId,
    turnId,
    status: status as 'completed' | 'interrupted' | 'failed'
  });
}

function parseCodexModelReroute(value: unknown): Extract<CodexLifecycleEvent, { type: 'app-reroute' }> {
  const root = object(value);
  const childThreadId = nonEmpty(root?.threadId);
  const turnId = nonEmpty(root?.turnId);
  const fromModel = nonEmpty(root?.fromModel);
  const toModel = nonEmpty(root?.toModel);
  const reasonValue = root?.reason;
  const reason = nonEmpty(reasonValue) ?? (object(reasonValue) ? JSON.stringify(reasonValue) : null);
  if (!childThreadId || !turnId || !fromModel || !toModel || !reason) {
    throw new Error('Codex App Server model reroute is invalid');
  }
  return Object.freeze({ type: 'app-reroute', childThreadId, turnId, fromModel, toModel, reason });
}

class CodexAppServerTransport {
  readonly #options: Required<Pick<AppServerTransportOptions, 'command' | 'args' | 'timeoutMs'>> & AppServerTransportOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = '';
  #stderr = '';
  #nextId = 1;
  #pending = new Map<number, Readonly<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>>();
  #notifications: Readonly<{ method: string; params: unknown }>[] = [];

  constructor(options: AppServerTransportOptions = {}) {
    this.#options = {
      ...options,
      command: options.command ?? 'codex',
      args: options.args ?? ['app-server', '--stdio'],
      timeoutMs: options.timeoutMs ?? 5_000
    };
  }

  get diagnostics(): readonly string[] {
    return Object.freeze(this.#stderr.split(/\r?\n/).filter(Boolean));
  }

  get notifications(): readonly Readonly<{ method: string; params: unknown }>[] {
    return Object.freeze([...this.#notifications]);
  }

  start(): void {
    if (this.#child) throw new Error('Codex App Server transport is already started');
    const child = spawn(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd,
      env: this.#options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-32 * 1024);
    });
    child.on('error', (error) => this.#rejectAll(error));
    child.on('exit', (code, signal) => {
      if (this.#pending.size) {
        this.#rejectAll(new Error(`Codex App Server exited before responding (code=${code}, signal=${signal})`));
      }
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try {
        const parsed = object(JSON.parse(line));
        if (!parsed) throw new Error('message is not an object');
        message = parsed;
      } catch (error) {
        this.#rejectAll(new Error(`Codex App Server returned invalid JSON: ${String(error)}`));
        continue;
      }
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(`Codex App Server request failed: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
      } else if (typeof message.method === 'string') {
        this.#notifications.push(Object.freeze({ method: message.method, params: message.params }));
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (!this.#child || !this.#child.stdin.writable) {
      return Promise.reject(new Error('Codex App Server transport is not running'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request '${method}' timed out`));
      }, this.#options.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    if (!this.#child || !this.#child.stdin.writable) throw new Error('Codex App Server transport is not running');
    this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async initialize(): Promise<unknown> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'agent-infra', title: 'agent-infra', version: '0.9.5' },
      capabilities: null
    });
    this.notify('initialized');
    return result;
  }

  close(): void {
    if (!this.#child) return;
    this.#child.stdin.end();
    this.#child.kill();
    this.#child = null;
  }
}

async function resolveCodexThread(
  childThreadId: string,
  options: AppServerTransportOptions = {}
): Promise<Readonly<{ resolution: ThreadResolution; reroutes: readonly Extract<CodexLifecycleEvent, { type: 'app-reroute' }>[]; diagnostics: readonly string[] }>> {
  if (!nonEmpty(childThreadId)) throw new Error('Codex child thread id is required');
  const transport = new CodexAppServerTransport(options);
  transport.start();
  try {
    await transport.initialize();
    const readResult = object(await transport.request('thread/read', { threadId: childThreadId, includeTurns: false }));
    const readThread = object(readResult?.thread);
    if (nonEmpty(readThread?.id) !== childThreadId) throw new Error('Codex App Server returned the wrong child thread');
    let resolution: ThreadResolution;
    try {
      resolution = parseCodexThreadResolution(readResult);
    } catch {
      throw new Error('Codex App Server settings are unavailable without thread/resume; refusing an unverified state-changing fallback');
    }
    const reroutes = transport.notifications
      .filter((entry) => entry.method === 'model/rerouted')
      .map((entry) => parseCodexModelReroute(entry.params))
      .filter((event) => event.childThreadId === childThreadId);
    return Object.freeze({ resolution, reroutes: Object.freeze(reroutes), diagnostics: transport.diagnostics });
  } finally {
    transport.close();
  }
}

async function resolveCodexTerminal(
  childThreadId: string,
  options: AppServerTransportOptions = {}
): Promise<Extract<CodexLifecycleEvent, { type: 'app-terminal' }>> {
  const transport = new CodexAppServerTransport(options);
  transport.start();
  try {
    await transport.initialize();
    const result = object(await transport.request('thread/read', { threadId: childThreadId, includeTurns: true }));
    const thread = object(result?.thread);
    if (nonEmpty(thread?.id) !== childThreadId) throw new Error('Codex App Server returned the wrong child thread');
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const turn = turns.at(-1);
    return parseCodexTurnCompleted({ threadId: childThreadId, turn });
  } finally {
    transport.close();
  }
}

async function preflightCodexLifecycleEvidence(
  repoRoot: string = process.cwd(),
  runtimeIdentity?: CodexRuntimeIdentity
) {
  const versionRun = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  const match = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(versionRun.stdout ?? '');
  if (versionRun.status !== 0 || !match?.[1] || !semver.gte(match[1], '0.147.0')) {
    throw new Error('CODEX_PREFLIGHT_VERSION_UNSUPPORTED');
  }
  const featuresRun = spawnSync('codex', ['features', 'list'], { encoding: 'utf8' });
  if (
    featuresRun.status !== 0
    || !/^hooks\s+\S+\s+true$/m.test(featuresRun.stdout)
    || !/^multi_agent\s+\S+\s+true$/m.test(featuresRun.stdout)
  ) throw new Error('CODEX_PREFLIGHT_FEATURE_DISABLED');

  const hooksPath = path.join(repoRoot, '.codex', 'hooks.json');
  const hooksRaw = fs.readFileSync(hooksPath, 'utf8');
  validateCodexLifecycleHookConfig(JSON.parse(hooksRaw));

  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-codex-schema-'));
  try {
    const schemaRun = spawnSync('codex', ['app-server', 'generate-json-schema', '--out', schemaDir], { encoding: 'utf8' });
    if (schemaRun.status !== 0) throw new Error('CODEX_PREFLIGHT_SCHEMA_UNAVAILABLE');
    const schema = fs.readFileSync(path.join(schemaDir, 'codex_app_server_protocol.v2.schemas.json'), 'utf8');
    for (const field of ['parentThreadId', 'forkedFromId', 'ThreadSettings', 'turn/completed', 'model/rerouted']) {
      if (!schema.includes(field)) throw new Error(`CODEX_PREFLIGHT_SCHEMA_MISSING:${field}`);
    }
  } finally {
    fs.rmSync(schemaDir, { recursive: true, force: true });
  }

  const hookDefinitionHash = crypto.createHash('sha256').update(hooksRaw).digest('hex');
  const runtimeRoot = path.join(repoRoot, '.agents', 'workspace', '.runtime', 'codex-lifecycle');
  const runtimeLiveness = hasCodexRuntimeLiveness(runtimeRoot, hookDefinitionHash, runtimeIdentity);

  const transport = new CodexAppServerTransport();
  transport.start();
  try { await transport.initialize(); } finally { transport.close(); }
  return Object.freeze({
    cliVersion: match[1],
    hookDefinitionHash,
    staticReady: true,
    runtimeLiveness,
    diagnostics: transport.diagnostics
  });
}

export {
  CodexAppServerTransport,
  hasCodexRuntimeLiveness,
  parseCodexModelReroute,
  parseCodexThreadResolution,
  parseCodexTurnCompleted,
  preflightCodexLifecycleEvidence,
  resolveCodexTerminal,
  resolveCodexThread,
  validateCodexLifecycleHookConfig
};
export type { AppServerTransportOptions, CodexRuntimeIdentity, ThreadResolution };
