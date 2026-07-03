import test from 'node:test';
import assert from 'node:assert/strict';

import { runInSandbox } from '../../../lib/sandbox/capture.ts';

test('runInSandbox fails clearly when no sandbox container exists', async () => {
  await assert.rejects(
    () =>
      runInSandbox(
        { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
        {
          engine: 'docker',
          repoRoot: '/repo',
          containerCandidates: ['demo-dev-feature-demo'],
          rows: [],
          spawn: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' })
        }
      ),
    /Sandbox for feature\/demo not found/
  );
});

test('runInSandbox starts stopped containers and schedules a tmux run without -it', async () => {
  const calls: string[] = [];
  const result = await runInSandbox(
    { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
    {
      engine: 'docker',
      runId: 'run-test-123',
      repoRoot: '/repo',
      containerCandidates: ['demo-dev-feature-demo'],
      rows: [{ name: 'demo-dev-feature-demo', status: 'Exited', branch: 'feature/demo', running: false, index: null }],
      startContainer: (name) => calls.push(`start:${name}`),
      spawn: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        return { exitCode: 0, signal: null, stdout: 'ok', stderr: '' };
      }
    }
  );
  assert.equal(result.stdout, 'ok');
  assert.deepEqual(result.run, {
    runId: 'run-test-123',
    engine: 'docker',
    container: 'demo-dev-feature-demo',
    runDir: '/tmp/agent-infra-runs/run-test-123'
  });
  assert.equal(calls[0], 'start:demo-dev-feature-demo');
  assert.match(calls[1] ?? '', /^docker exec /);
  assert.doesNotMatch(calls[1] ?? '', / -it /);
  assert.match(calls[1] ?? '', / bash -lc /);
});

test('runInSandbox launcher creates a tmux window and run status files', async () => {
  let dockerArgs: string[] = [];
  const result = await runInSandbox(
    { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
    {
      engine: 'docker',
      runId: 'run-test-456',
      repoRoot: '/repo',
      containerCandidates: ['demo-dev-feature-demo'],
      rows: [{ name: 'demo-dev-feature-demo', status: 'Up', branch: 'feature/demo', running: true, index: null }],
      spawn: async (_file, args) => {
        dockerArgs = args;
        return { exitCode: 0, signal: null, stdout: 'started', stderr: '' };
      }
    }
  );

  const launcher = dockerArgs.at(-1) ?? '';
  assert.equal(result.stdout, 'started');
  assert.deepEqual(result.run, {
    runId: 'run-test-456',
    engine: 'docker',
    container: 'demo-dev-feature-demo',
    runDir: '/tmp/agent-infra-runs/run-test-456'
  });
  assert.match(launcher, /run-test-456/);
  assert.match(launcher, /tmux new-window -d -P -F/);
  assert.match(launcher, /tmux pipe-pane -o/);
  assert.match(launcher, /tmux send-keys -t/);
  assert.ok(launcher.includes('/tmp/agent-infra-runs/run-test-456'));
  assert.match(launcher, /status/);
});
