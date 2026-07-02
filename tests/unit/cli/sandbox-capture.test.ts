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

test('runInSandbox starts stopped containers and uses docker exec without -it', async () => {
  const calls: string[] = [];
  const result = await runInSandbox(
    { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
    {
      engine: 'docker',
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
  assert.equal(calls[0], 'start:demo-dev-feature-demo');
  assert.match(calls[1] ?? '', /^docker exec /);
  assert.doesNotMatch(calls[1] ?? '', / -it /);
});

test('runInSandbox forwards stdout and stderr chunk callbacks to spawn', async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const result = await runInSandbox(
    { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
    {
      engine: 'docker',
      repoRoot: '/repo',
      containerCandidates: ['demo-dev-feature-demo'],
      rows: [{ name: 'demo-dev-feature-demo', status: 'Up', branch: 'feature/demo', running: true, index: null }],
      onStdoutChunk: (chunk) => {
        stdoutChunks.push(chunk);
      },
      onStderrChunk: (chunk) => {
        stderrChunks.push(chunk);
      },
      spawn: async (_file, _args, options) => {
        options?.onStdoutChunk?.('out');
        options?.onStderrChunk?.('err');
        return { exitCode: 0, signal: null, stdout: 'out', stderr: 'err' };
      }
    }
  );

  assert.deepEqual(stdoutChunks, ['out']);
  assert.deepEqual(stderrChunks, ['err']);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});
