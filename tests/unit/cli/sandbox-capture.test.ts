import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { runInSandbox } from '../../../lib/sandbox/capture.ts';
import { onPlatforms } from '../../helpers.ts';

const PORTABLE_TIMESTAMP_COMMAND =
  `date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\\([+-][0-9][0-9]\\)\\([0-9][0-9]\\)$/\\1:\\2/'`;

test('runInSandbox fails clearly when no sandbox container exists', async () => {
  await assert.rejects(
    () =>
      runInSandbox(
        { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
        {
          engine: 'native',
          repoRoot: '/repo',
          containerCandidates: ['demo-dev-feature-demo'],
          rows: [],
          spawn: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' })
        }
      ),
    /Sandbox for feature\/demo not found/
  );
});

test('runInSandbox waits for sandbox readiness before scheduling a tmux run without -it', async () => {
  const calls: string[] = [];
  const result = await runInSandbox(
    { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'], recreate: true },
    {
      engine: 'native',
      runId: 'run-test-123',
      repoRoot: '/repo',
      containerCandidates: ['demo-dev-feature-demo'],
      rows: [{ name: 'demo-dev-feature-demo', status: 'Exited', branch: 'feature/demo', running: false, index: null }],
      ensureReady: async ({ branch, row, allowRecreate }) => {
        calls.push(`ready:${branch}:${row.name}:${allowRecreate}`);
        return { container: row.name, path: 'recovered', warnings: [] };
      },
      spawn: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        return { exitCode: 0, signal: null, stdout: 'ok', stderr: '' };
      }
    }
  );
  assert.equal(result.stdout, 'ok');
  assert.deepEqual(result.run, {
    runId: 'run-test-123',
    engine: 'native',
    container: 'demo-dev-feature-demo',
    runDir: '/tmp/agent-infra-runs/run-test-123'
  });
  assert.equal(calls[0], 'ready:feature/demo:demo-dev-feature-demo:true');
  assert.match(calls[1] ?? '', /^docker exec /);
  assert.doesNotMatch(calls[1] ?? '', / -it /);
  assert.match(calls[1] ?? '', / bash -lc /);
});

test('runInSandbox does not create run state when readiness fails', async () => {
  let spawned = false;
  await assert.rejects(
    () => runInSandbox(
      { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
      {
        engine: 'native',
        repoRoot: '/repo',
        containerCandidates: ['demo-dev-feature-demo'],
        rows: [{ name: 'demo-dev-feature-demo', status: 'Up', branch: 'feature/demo', running: true, index: null }],
        ensureReady: async () => {
          throw new Error('sandbox recovery failed');
        },
        spawn: async () => {
          spawned = true;
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        }
      }
    ),
    /sandbox recovery failed/
  );
  assert.equal(spawned, false);
});

test('runInSandbox launcher creates a tmux window and run status files', async () => {
  let dockerArgs: string[] = [];
  const result = await runInSandbox(
    { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
    {
      engine: 'native',
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
    engine: 'native',
    container: 'demo-dev-feature-demo',
    runDir: '/tmp/agent-infra-runs/run-test-456'
  });
  assert.match(launcher, /run-test-456/);
  assert.match(launcher, /tmux new-window -d -P -F/);
  assert.match(launcher, /tmux pipe-pane -o/);
  assert.match(launcher, /tmux send-keys -t/);
  assert.ok(launcher.includes('/tmp/agent-infra-runs/run-test-456'));
  assert.match(launcher, /status/);
  const encodedRunScript = launcher.match(/printf '%s' '([^']+)' \| base64 -d/)?.[1];
  assert.ok(encodedRunScript, 'launcher should embed a base64-encoded run script');
  const runScript = Buffer.from(encodedRunScript, 'base64').toString('utf8');
  assert.equal(runScript.split(PORTABLE_TIMESTAMP_COMMAND).length - 1, 2);
});

test('runInSandbox selects the configured Docker context for capture exec', async () => {
  const calls: Array<[string, string[]]> = [];
  await runInSandbox(
    { taskRef: '#7', branch: 'feature/demo', command: ['codex', 'exec', '$code-task #7'] },
    {
      engine: 'orbstack',
      runId: 'run-context',
      repoRoot: '/repo',
      containerCandidates: ['demo-dev-feature-demo'],
      rows: [{ name: 'demo-dev-feature-demo', status: 'Up', branch: 'feature/demo', running: true, index: null }],
      spawn: async (file, args) => {
        calls.push([file, args]);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      }
    }
  );

  assert.equal(calls[0]?.[0], 'docker');
  assert.deepEqual(calls[0]?.[1].slice(0, 3), ['--context', 'orbstack', 'exec']);
  assert.ok(calls[0]?.[1].includes('demo-dev-feature-demo'));
});

test('portable timestamp command formats non-hour negative offsets', onPlatforms('linux', 'darwin'), () => {
  const result = spawnSync('sh', ['-c', PORTABLE_TIMESTAMP_COMMAND], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/St_Johns' }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}-\d{2}:30$/);
});
