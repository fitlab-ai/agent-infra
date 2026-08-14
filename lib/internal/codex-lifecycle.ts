import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  preflightCodexLifecycleEvidence,
  resolveCodexTerminal,
  resolveCodexThread
} from '../agent-clients/adapters/codex-lifecycle/app-server.ts';
import { createCodexLifecycleStore } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import type { CodexLifecycleEvent } from '../agent-clients/adapters/codex-lifecycle/evidence.ts';
import {
  activateCodexOrchestrationDelegation,
  reconcileCodexOrchestrationDelegation,
  sealCodexOrchestrationDelegation
} from '../task/codex-orchestration.ts';

const USAGE = 'Usage: agent-infra-internal codex-lifecycle <hook-event|resolve-start|resolve-stop|preflight|consume> [options]\n';
const MANAGED_AGENT = /^agent-infra-lifecycle-(executor|reviewer)$/;

type Parsed = Readonly<{ operation: string; values: Readonly<Record<string, string>> }>;
type UnresolvedHookChild = Omit<Extract<CodexLifecycleEvent, { type: 'hook-child' }>, 'parentThreadId'>;

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function failure(code: string, message: string): void {
  output({ status: 'failed', changed: false, evidence: null, diagnostics: [], error: { code, message } });
  process.exitCode = 1;
}

function outputBridgeResult(result: Awaited<ReturnType<typeof activateCodexOrchestrationDelegation>>): void {
  if (result.error?.code === 'ORCHESTRATION_DELEGATION_MISSING') {
    output({ status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null });
    return;
  }
  output(result);
  if (result.status !== 'running') process.exitCode = 1;
}

function parse(args: string[]): Parsed | null {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return null;
  }
  const operation = args[0];
  if (!operation) {
    failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', 'operation is required');
    return null;
  }
  const allowed = {
    'hook-event': ['--event', '--bridge'],
    'resolve-start': ['--child-id'],
    'resolve-stop': ['--child-id'],
    preflight: ['--format', '--session-id', '--turn-id', '--tool-use-id'],
    consume: ['--child-id', '--consumer']
  }[operation];
  if (!allowed) {
    failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', 'unknown operation');
    return null;
  }
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.includes(flag) || Object.hasOwn(values, flag)) {
      failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', `invalid or duplicate option '${flag}'`);
      return null;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', `option '${flag}' requires a value`);
      return null;
    }
    values[flag] = value;
  }
  return Object.freeze({ operation, values: Object.freeze(values) });
}

function cliVersion(): string {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  const version = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(result.stdout ?? '')?.[1];
  if (result.status !== 0 || !version) throw new Error('Codex CLI version is unavailable');
  return version;
}

function hookDefinitionHash(): string {
  const file = path.join(process.cwd(), '.codex', 'hooks.json');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function readStdin(): Promise<unknown> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Codex lifecycle input exceeds 64 KiB');
  }
  return JSON.parse(input || '{}') as unknown;
}

function recordFromPayload(phase: string, payload: unknown): CodexLifecycleEvent | UnresolvedHookChild | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Codex lifecycle hook payload must be an object');
  }
  const value = payload as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : '';
  if (!MANAGED_AGENT.test(text('nativeAgent'))) return null;
  if (phase === 'pre-tool') return {
    type: 'hook-spawn',
    sessionId: text('sessionId'),
    turnId: text('turnId'),
    toolUseId: text('toolUseId'),
    nativeAgent: text('nativeAgent'),
    ...(text('requestedModel') ? { requestedModel: text('requestedModel') } : {}),
    ...(text('requestedReasoningEffort') ? { requestedReasoningEffort: text('requestedReasoningEffort') } : {}),
    hookDefinitionHash: text('hookDefinitionHash')
  };
  if (phase === 'subagent-start') return {
    type: 'hook-child',
    sessionId: text('sessionId'),
    turnId: text('turnId'),
    childThreadId: text('childThreadId'),
    nativeAgent: text('nativeAgent')
  };
  if (phase === 'subagent-stop') return {
    type: 'hook-stop',
    sessionId: text('sessionId'),
    turnId: text('turnId'),
    childThreadId: text('childThreadId'),
    nativeAgent: text('nativeAgent')
  };
  if (phase === 'post-tool') return null;
  throw new Error(`unknown Codex lifecycle hook phase '${phase}'`);
}

async function codexLifecycle(args: string[] = []): Promise<void> {
  const parsed = parse(args);
  if (!parsed || process.exitCode) return;
  try {
    if (parsed.operation === 'preflight') {
      const format = parsed.values['--format'] ?? 'json';
      if (!['text', 'json'].includes(format)) throw new Error("format must be 'text' or 'json'");
      const runtimeFields = [
        parsed.values['--session-id'],
        parsed.values['--turn-id'],
        parsed.values['--tool-use-id']
      ];
      if (runtimeFields.some(Boolean) && !runtimeFields.every(Boolean)) {
        throw new Error('preflight runtime identity requires --session-id, --turn-id, and --tool-use-id together');
      }
      const runtimeIdentity = runtimeFields.every(Boolean) ? {
        sessionId: runtimeFields[0]!,
        turnId: runtimeFields[1]!,
        toolUseId: runtimeFields[2]!
      } : undefined;
      const result = await preflightCodexLifecycleEvidence(process.cwd(), runtimeIdentity);
      if (format === 'text') {
        process.stdout.write(`Codex lifecycle static preflight: ready\nCLI: ${result.cliVersion}\nRuntime hook liveness: ${result.runtimeLiveness ? 'observed' : 'not-yet-observed'}\n`);
      } else output({ status: 'ready', changed: false, evidence: result, diagnostics: result.diagnostics, error: null });
      return;
    }

    const store = createCodexLifecycleStore({ cliVersion: cliVersion() });
    if (parsed.operation === 'hook-event') {
      const phase = parsed.values['--event'];
      if (!phase || !['pre-tool', 'subagent-start', 'post-tool', 'subagent-stop'].includes(phase)) {
        throw new Error('hook-event requires a known --event');
      }
      if (parsed.values['--bridge'] !== undefined && parsed.values['--bridge'] !== 'true') {
        throw new Error("hook-event --bridge must be 'true'");
      }
      const payload = await readStdin();
      const event = recordFromPayload(phase, payload);
      if (!event) {
        if (phase === 'post-tool' && parsed.values['--bridge'] === 'true') {
          const value = payload as Record<string, unknown>;
          const childThreadId = String(value.childThreadId ?? '');
          const reconciled = reconcileCodexOrchestrationDelegation(childThreadId);
          outputBridgeResult(reconciled);
          return;
        }
        output({ status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null });
        return;
      }
      if (parsed.values['--bridge'] === 'true' && event.type === 'hook-stop') {
        try {
          if (store.read(event.childThreadId).consumer) {
            const bridged = await sealCodexOrchestrationDelegation(event.childThreadId, { store });
            outputBridgeResult(bridged);
            return;
          }
        } catch {
          // The normal apply path below owns missing or invalid evidence errors.
        }
      }
      if (parsed.values['--bridge'] === 'true' && event.type === 'hook-child') {
        const resolved = await resolveCodexThread(event.childThreadId);
        store.apply({
          ...event,
          parentThreadId: resolved.resolution.thread.parentThreadId
        });
        const bridged = await activateCodexOrchestrationDelegation(event.childThreadId, {
          store,
          resolveThread: async () => resolved
        });
        outputBridgeResult(bridged);
        return;
      }
      if (event.type === 'hook-child') {
        const resolved = await resolveCodexThread(event.childThreadId);
        const result = store.apply({
          ...event,
          parentThreadId: resolved.resolution.thread.parentThreadId
        });
        output({ status: result.state.status, changed: true, evidence: result.state, diagnostics: resolved.diagnostics, error: result.state.error });
        if (result.state.status === 'invalid') process.exitCode = 1;
        return;
      }
      const result = store.apply(event);
      if (parsed.values['--bridge'] === 'true' && event.type === 'hook-stop') {
        const bridged = await sealCodexOrchestrationDelegation(event.childThreadId, { store });
        outputBridgeResult(bridged);
        return;
      }
      output({ status: result.state.status, changed: true, evidence: result.state, diagnostics: [], error: result.state.error });
      if (result.state.status === 'invalid') process.exitCode = 1;
      return;
    }

    const childThreadId = parsed.values['--child-id'];
    if (!childThreadId) throw new Error(`operation '${parsed.operation}' requires --child-id`);
    if (parsed.operation === 'resolve-start') {
      if (store.read(childThreadId).state.spawn?.hookDefinitionHash !== hookDefinitionHash()) {
        throw new Error('Codex lifecycle hook definition hash is stale');
      }
      const resolved = await resolveCodexThread(childThreadId);
      let latest = store.apply(resolved.resolution.thread);
      for (const reroute of resolved.reroutes) latest = store.apply(reroute);
      latest = store.apply(resolved.resolution.settings);
      output({ status: latest.state.status, changed: true, evidence: latest.state.startEvidence, diagnostics: resolved.diagnostics, error: latest.state.error });
      if (latest.state.status !== 'start-ready') process.exitCode = 1;
      return;
    }
    if (parsed.operation === 'resolve-stop') {
      const terminal = await resolveCodexTerminal(childThreadId);
      const latest = store.apply(terminal);
      if (latest.state.status !== 'stop-ready') {
        throw new Error(`Codex lifecycle stop evidence is not ready (status=${latest.state.status})`);
      }
      output({ status: latest.state.status, changed: true, evidence: latest.state.stopEvidence, diagnostics: [], error: latest.state.error });
      return;
    }
    if (parsed.operation === 'consume') {
      const consumer = parsed.values['--consumer'];
      if (!consumer) throw new Error('consume requires --consumer');
      const consumed = store.consume(childThreadId, consumer, hookDefinitionHash());
      output({ status: 'consumed', changed: true, evidence: {
        start: consumed.state.startEvidence,
        stop: consumed.state.stopEvidence
      }, diagnostics: [], error: null });
    }
  } catch (error) {
    failure('CODEX_LIFECYCLE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export { codexLifecycle };
