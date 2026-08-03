import { execFileSync } from 'node:child_process';

const MAX_INPUT_BYTES = 64 * 1024;
const clientIndex = process.argv.indexOf('--client');
const client = clientIndex >= 0 ? process.argv[clientIndex + 1] : '';
if (client !== 'claude-code') {
  process.stderr.write('Lifecycle delegation hook requires a supported --client value\n');
  process.exit(1);
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
  const hook = String(event.hook_event_name || event.event || '').toLowerCase();
  const nativeAgent = event.agent_name || event.agent_type || event.agent?.name;
  if (!String(nativeAgent || '').startsWith('agent-infra-lifecycle-')) process.exit(0);
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
      '--parent-id', String(event.parent_id || event.parent_session_id || event.session_id || ''),
      '--spawn-mode', String(event.spawn_mode || 'fresh')
    );
    if (event.model) args.push('--actual-model', String(event.model));
    if (event.model_fallback_reason) args.push('--fallback-reason', String(event.model_fallback_reason));
  } else {
    args.push(
      '--native-agent', String(nativeAgent),
      '--child-id', String(event.child_id || event.agent_id || event.thread_id || '')
    );
  }
  try {
    const output = execFileSync('agent-infra-internal', args, {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    process.stdout.write(output);
  } catch (error) {
    if (error.stdout) process.stdout.write(String(error.stdout));
    if (error.stderr) process.stderr.write(String(error.stderr));
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
});
