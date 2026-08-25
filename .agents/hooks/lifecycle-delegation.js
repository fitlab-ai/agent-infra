import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 64 * 1024;
const codexHooks = fileURLToPath(new URL('../../.codex/hooks.json', import.meta.url));
const clientIndex = process.argv.indexOf('--client');
const client = clientIndex >= 0 ? process.argv[clientIndex + 1] : '';
if (client !== 'claude-code' && client !== 'codex') {
  process.stderr.write('Lifecycle delegation hook requires a supported --client value\n');
  process.exit(1);
}

function internalCliInvocation(args) {
  return { command: 'agent-infra-internal', commandArgs: args, shell: process.platform === 'win32' };
}

function findCapabilityToken(value, depth = 0) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') {
    const match = /agent-infra-codex-capability:([A-Za-z0-9_-]{20,})/.exec(value);
    return match?.[1] || '';
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCapabilityToken(entry, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const found = findCapabilityToken(entry, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    process.stderr.write('Lifecycle delegation hook input exceeds 64 KiB\n');
    process.exit(1);
  }
});
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input || '{}');
  } catch {
    process.stderr.write('Lifecycle delegation hook received invalid JSON\n');
    process.exit(1);
  }
  const phaseIndex = process.argv.indexOf('--event');
  const explicitPhase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : '';
  const hook = String(explicitPhase || event.hook_event_name || event.event || '').toLowerCase();
  const toolInput = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const toolName = String(event.tool_name || event.tool || '').toLowerCase();
  let toolResponse = {};
  try {
    toolResponse = typeof event.tool_response === 'string'
      ? JSON.parse(event.tool_response)
      : (event.tool_response || {});
  } catch {
    // Core ignores opaque tool responses; only the host timeout bit is forwarded.
  }
  const nativeAgent = event.agent_name || event.agent_type || event.agent?.name
    || toolInput.agent_type || toolInput.agent || toolInput.name;
  if (client === 'codex') {
    const phases = new Set(['pre-tool', 'subagent-start', 'post-tool', 'subagent-stop']);
    if (!phases.has(hook)) {
      process.stderr.write('Managed Codex lifecycle hook event has an unknown type\n');
      process.exit(1);
    }
    const managedAgent = /^agent-infra-lifecycle-(executor|reviewer)$/.test(String(nativeAgent || ''));
    const capabilityToken = hook === 'post-tool' ? findCapabilityToken(toolResponse) : '';
    const parentReconcile = hook === 'post-tool'
      && toolName === 'collaborationwait_agent'
      && toolResponse.timed_out !== true;
    if (!managedAgent && !parentReconcile && !capabilityToken) process.exit(0);
    const hookDefinitionHash = createHash('sha256').update(readFileSync(codexHooks)).digest('hex');
    const normalized = {
      sessionId: String(event.session_id || ''),
      turnId: String(event.turn_id || ''),
      toolUseId: String(event.tool_use_id || ''),
      childThreadId: String(event.agent_id || event.child_id || event.thread_id || event.tool_response?.agent_id || ''),
      nativeAgent: String(nativeAgent),
      requestedModel: String(toolInput.model || ''),
      requestedReasoningEffort: String(toolInput.reasoning_effort || toolInput.reasoningEffort || ''),
      hookDefinitionHash,
      toolName,
      taskName: String(toolInput.task_name || ''),
      transcriptPath: String(event.transcript_path || '')
    };
    if (capabilityToken) normalized.capabilityToken = capabilityToken;
    const args = ['codex-lifecycle', 'hook-event', '--event', hook, '--bridge', 'true'];
    try {
      const { command, commandArgs, shell } = internalCliInvocation(args);
      const output = execFileSync(command, commandArgs, {
        encoding: 'utf8',
        input: JSON.stringify(normalized),
        shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000
      });
      process.stdout.write(output);
    } catch (error) {
      if (error.stdout) process.stdout.write(String(error.stdout));
      if (error.stderr) process.stderr.write(String(error.stderr));
      process.exit(typeof error.status === 'number' ? error.status : 1);
    }
    return;
  }
  if (!/^agent-infra-lifecycle-(executor|reviewer)$/.test(String(nativeAgent || ''))) process.exit(0);
  const start = hook.includes('start');
  const stop = hook.includes('stop');
  if (!start && !stop) {
    process.stderr.write('Managed lifecycle hook event has an unknown type\n');
    process.exit(1);
  }
  const args = ['task-orchestration', 'auto', start ? 'hook-start' : 'hook-stop', '--client', client];
  if (start) {
    args.push(
      '--native-agent', String(nativeAgent),
      '--child-id', String(event.child_id || event.agent_id || event.thread_id || ''),
      '--parent-id', String(event.parent_id || event.parent_session_id || event.session_id || '')
    );
    if (event.spawn_mode) args.push('--spawn-mode', String(event.spawn_mode));
    if (event.model) args.push('--actual-model', String(event.model));
    const actualEffort = event.effort?.level || event.actual_reasoning_effort || event.reasoning_effort || event.model_reasoning_effort;
    if (actualEffort) args.push('--actual-reasoning-effort', String(actualEffort));
    if (event.model_fallback_reason) args.push('--model-fallback-reason', String(event.model_fallback_reason));
    if (event.reasoning_effort_fallback_reason) {
      args.push('--reasoning-effort-fallback-reason', String(event.reasoning_effort_fallback_reason));
    }
  } else {
    args.push(
      '--native-agent', String(nativeAgent),
      '--child-id', String(event.child_id || event.agent_id || event.thread_id || '')
    );
    if (client === 'claude-code') {
      if (event.model) args.push('--actual-model', String(event.model));
      const actualEffort = event.effort?.level || event.actual_reasoning_effort || event.reasoning_effort;
      if (actualEffort) args.push('--actual-reasoning-effort', String(actualEffort));
    }
  }
  try {
    const { command, commandArgs, shell } = internalCliInvocation(args);
    const output = execFileSync(command, commandArgs, {
      encoding: 'utf8',
      shell,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    process.stdout.write(output);
  } catch (error) {
    if (error.stdout) process.stdout.write(String(error.stdout));
    if (error.stderr) process.stderr.write(String(error.stderr));
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
});
