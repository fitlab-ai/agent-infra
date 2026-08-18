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

type DiscoveredHook = Readonly<{
  eventName: string;
  matcher: string | null;
  command: string;
  enabled: boolean;
  source: string;
  sourcePathDigest: string;
  trustStatus: string;
  currentHash: string;
  isManaged: boolean;
  pluginId: string | null;
}>;

type AppServerTransportOptions = Readonly<{
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  rolloutReadAttempts?: number;
  rolloutRetryMs?: number;
}>;

type CodexRuntimeIdentity = Readonly<{
  sessionId: string;
  turnId: string;
  toolUseId: string;
}>;

const LIFECYCLE_HOOKS = Object.freeze([
  Object.freeze({ event: 'PreToolUse', matcher: '^collaborationspawn_agent$', phase: 'pre-tool' }),
  Object.freeze({ event: 'PostToolUse', matcher: '', phase: 'post-tool' }),
  Object.freeze({ event: 'SubagentStart', matcher: '', phase: 'subagent-start' }),
  Object.freeze({ event: 'SubagentStop', matcher: '', phase: 'subagent-stop' })
]);
const DEFAULT_ROLLOUT_READ_ATTEMPTS = 81;
const DEFAULT_ROLLOUT_RETRY_MS = 100;

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function resolveCodexSpawnedChild(
  transcriptPath: string,
  expected: Readonly<{
    sessionId: string;
    toolUseId: string;
    nativeAgent: string;
    taskName: string;
    requestedModel?: string;
    requestedReasoningEffort?: string;
  }>
): string {
  const name = path.basename(transcriptPath);
  if (!transcriptPath || (!name.endsWith(`-${expected.sessionId}.jsonl`) && name !== `${expected.sessionId}.jsonl`)) {
    throw new Error('Codex parent rollout path is invalid');
  }
  const stat = fs.lstatSync(transcriptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex parent rollout is not a regular file');
  const maxBytes = 8 * 1024 * 1024;
  const offset = Math.max(0, stat.size - maxBytes);
  const buffer = Buffer.alloc(stat.size - offset);
  const descriptor = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(descriptor, buffer, 0, buffer.length, offset);
  } finally {
    fs.closeSync(descriptor);
  }
  let text = buffer.toString('utf8');
  if (offset) text = text.slice(text.indexOf('\n') + 1);
  const records = text.split(/\r?\n/).filter(Boolean).map((line) => object(JSON.parse(line))).filter(Boolean);
  const calls = records.filter((record) => {
    const payload = object(record?.payload);
    return record?.type === 'response_item'
      && payload?.type === 'function_call'
      && payload.call_id === expected.toolUseId
      && payload.namespace === 'collaboration'
      && payload.name === 'spawn_agent';
  });
  if (calls.length !== 1) throw new Error('Codex parent rollout spawn call was not found uniquely');
  const call = object(calls[0]?.payload);
  const args = object(JSON.parse(nonEmpty(call?.arguments) ?? '{}'));
  if (
    args?.agent_type !== expected.nativeAgent
    || args.task_name !== expected.taskName
    || (expected.requestedModel && args.model !== expected.requestedModel)
    || (expected.requestedReasoningEffort && args.reasoning_effort !== expected.requestedReasoningEffort)
  ) throw new Error('Codex parent rollout spawn identity does not match the hook event');
  const activities = records.filter((record) => {
    const payload = object(record?.payload);
    return record?.type === 'event_msg'
      && payload?.type === 'sub_agent_activity'
      && payload.event_id === expected.toolUseId
      && payload.kind === 'started'
      && payload.agent_path === `/root/${expected.taskName}`
      && nonEmpty(payload.agent_thread_id);
  });
  if (activities.length !== 1) throw new Error('Codex parent rollout child activity was not found uniquely');
  return nonEmpty(object(activities[0]?.payload)?.agent_thread_id)!;
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
          && hook.timeout === 15
          && hook.command === `node "$(git rev-parse --show-toplevel)/.agents/hooks/lifecycle-delegation.js" --client codex --event ${phase}`;
      });
    });
  });
  if (!valid) throw new Error('CODEX_PREFLIGHT_HOOKS_INVALID: lifecycle hooks are invalid');
}

function parseCodexHooksList(
  value: unknown,
  repoRoot: string,
  expectedSource: 'direct-host' | 'isolated-user' = 'direct-host'
): readonly DiscoveredHook[] {
  const root = object(value);
  const entries = Array.isArray(root?.data) ? root.data : [];
  const entry = entries.map(object).find((candidate) => candidate?.cwd === repoRoot);
  const errors = Array.isArray(entry?.errors) ? entry.errors : [];
  if (errors.length) throw new Error(`CODEX_PREFLIGHT_HOOK_DISCOVERY_FAILED: ${errors.map(String).join('; ')}`);
  const hooks = (Array.isArray(entry?.hooks) ? entry.hooks : [])
    .map(object)
    .filter((hook): hook is JsonObject => hook !== null)
    .map((hook) => Object.freeze({
      eventName: String(hook.eventName ?? ''),
      matcher: typeof hook.matcher === 'string' ? hook.matcher : null,
      command: String(hook.command ?? ''),
      enabled: hook.enabled === true,
      source: String(hook.source ?? ''),
      sourcePathDigest: typeof hook.sourcePath === 'string' && path.isAbsolute(hook.sourcePath)
        ? crypto.createHash('sha256').update(hook.sourcePath).digest('hex')
        : '',
      trustStatus: String(hook.trustStatus ?? ''),
      currentHash: String(hook.currentHash ?? ''),
      isManaged: hook.isManaged === true,
      pluginId: typeof hook.pluginId === 'string' ? hook.pluginId : null
    }));
  const valid = LIFECYCLE_HOOKS.every(({ event, matcher, phase }) => hooks.some((hook) =>
    hook.eventName === event.replace(/^./, (character) => character.toLowerCase())
    && hook.matcher === matcher
    && hook.command === `node "$(git rev-parse --show-toplevel)/.agents/hooks/lifecycle-delegation.js" --client codex --event ${phase}`
    && hook.enabled
    && hook.currentHash.length > 0
    && hook.sourcePathDigest.length === 64
    && hook.pluginId === null
    && (expectedSource === 'isolated-user'
      ? hook.source === 'user' && hook.trustStatus !== 'modified'
      : (hook.source === 'project' && hook.trustStatus === 'trusted')
        || hook.isManaged && hook.trustStatus === 'managed')
  ));
  if (!valid) throw new Error('CODEX_PREFLIGHT_HOOKS_NOT_LOADED: lifecycle hooks are not loaded for this workspace');
  return Object.freeze(hooks);
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

function parseCodexThreadResolution(readValue: unknown, rolloutRecords: readonly unknown[]): ThreadResolution {
  const readRoot = object(readValue);
  const thread = object(readRoot?.thread);
  const source = object(thread?.source);
  const subAgent = object(source?.subAgent);
  const threadSpawn = object(subAgent?.thread_spawn);
  const sessionMeta = rolloutRecords
    .map(object)
    .find((record) => record?.type === 'session_meta');
  const sessionPayload = object(sessionMeta?.payload);
  const turnContext = rolloutRecords
    .map(object)
    .filter((record) => record?.type === 'turn_context')
    .at(-1);
  const turnPayload = object(turnContext?.payload);
  const childThreadId = nonEmpty(thread?.id);
  const parentThreadId = nonEmpty(thread?.parentThreadId);
  const sourceParentThreadId = nonEmpty(threadSpawn?.parent_thread_id);
  const rolloutChildThreadId = nonEmpty(sessionPayload?.id);
  const rolloutParentThreadId = nonEmpty(sessionPayload?.parent_thread_id);
  const agentRole = nonEmpty(sessionPayload?.agent_role);
  const model = nonEmpty(turnPayload?.model);
  const reasoningEffort = nonEmpty(turnPayload?.effort);
  const forkedFromId = thread?.forkedFromId;
  if (
    !childThreadId
    || rolloutChildThreadId !== childThreadId
    || !parentThreadId
    || !sourceParentThreadId
    || rolloutParentThreadId !== parentThreadId
    || rolloutParentThreadId !== sourceParentThreadId
    || !/^agent-infra-lifecycle-(executor|reviewer)$/.test(agentRole ?? '')
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
      sourceParentThreadId,
      nativeAgent: agentRole!
    }),
    settings: Object.freeze({
      type: 'app-settings',
      childThreadId,
      model,
      reasoningEffort
    })
  });
}

function readCodexRolloutRecords(readValue: unknown, childThreadId: string): readonly unknown[] {
  const thread = object(object(readValue)?.thread);
  const rolloutPath = nonEmpty(thread?.path);
  const rolloutName = rolloutPath ? path.basename(rolloutPath) : '';
  if (!rolloutPath || (rolloutName !== `${childThreadId}.jsonl` && !rolloutName.endsWith(`-${childThreadId}.jsonl`))) {
    throw new Error('Codex App Server rollout path is invalid');
  }
  const stat = fs.statSync(rolloutPath);
  if (!stat.isFile()) throw new Error('Codex App Server rollout path is not a regular file');
  const maxBytes = 1024 * 1024;
  const bytes = Math.min(stat.size, maxBytes);
  const descriptor = fs.openSync(rolloutPath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(descriptor, buffer, 0, bytes, 0);
    const text = buffer.toString('utf8');
    const completeText = stat.size <= maxBytes ? text : text.slice(0, text.lastIndexOf('\n'));
    return Object.freeze(completeText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
  } finally {
    fs.closeSync(descriptor);
  }
}

async function resolveCodexRolloutRecords(
  readValue: unknown,
  childThreadId: string,
  attempts: number,
  retryMs: number
): Promise<readonly unknown[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const records = readCodexRolloutRecords(readValue, childThreadId);
      parseCodexThreadResolution(readValue, records);
      return records;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  throw lastError;
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
      const rolloutRecords = await resolveCodexRolloutRecords(
        readResult,
        childThreadId,
        options.rolloutReadAttempts ?? DEFAULT_ROLLOUT_READ_ATTEMPTS,
        options.rolloutRetryMs ?? DEFAULT_ROLLOUT_RETRY_MS
      );
      resolution = parseCodexThreadResolution(readResult, rolloutRecords);
    } catch {
      throw new Error('Codex App Server rollout metadata is unavailable');
    }
    const reroutes = transport.notifications
      .filter((entry) => entry.method === 'model/rerouted')
      .map((entry) => parseCodexModelReroute(entry.params))
      .filter((event) => event.childThreadId === childThreadId);
    return Object.freeze({ resolution, reroutes: Object.freeze(reroutes), diagnostics: transport.diagnostics });
  } finally {
    try {
      await transport.request('thread/unsubscribe', { threadId: childThreadId });
    } catch {
      // Closing the short-lived transport still removes the subscription.
    }
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
    const turnValue = object(turn);
    if (!turnValue || turnValue.status === 'inProgress') throw new Error('CODEX_TURN_NOT_TERMINAL');
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
  let discoveredHooks: readonly DiscoveredHook[];
  try {
    await transport.initialize();
    discoveredHooks = parseCodexHooksList(
      await transport.request('hooks/list', { cwds: [repoRoot] }),
      repoRoot,
      process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT ? 'isolated-user' : 'direct-host'
    );
  } finally { transport.close(); }
  return Object.freeze({
    cliVersion: match[1],
    hookDefinitionHash,
    staticReady: true,
    discoveredHooks,
    runtimeLiveness,
    diagnostics: transport.diagnostics
  });
}

export {
  CodexAppServerTransport,
  hasCodexRuntimeLiveness,
  parseCodexModelReroute,
  parseCodexHooksList,
  parseCodexThreadResolution,
  parseCodexTurnCompleted,
  resolveCodexSpawnedChild,
  preflightCodexLifecycleEvidence,
  resolveCodexTerminal,
  resolveCodexThread,
  validateCodexLifecycleHookConfig
};
export type { AppServerTransportOptions, CodexRuntimeIdentity, ThreadResolution };
