import test from 'node:test';
import assert from 'node:assert/strict';

import { commandHelp, parseCommand } from '../../../lib/server/protocol.ts';

test('commandHelp renders Feishu-card-friendly command lines', () => {
  assert.deepEqual(commandHelp().split('\n').slice(1), [
    'Built-ins:',
    '/help',
    '/ping',
    '/version',
    'Read:',
    '/sandbox ls',
    '/sandbox show {ref}',
    '/sandbox vm status',
    '/task decisions {ref}',
    '/task log {ref}',
    '/task ls',
    '/task show {ref}',
    '/task status {ref}',
    'Write:',
    '/sandbox create {ref}',
    '/sandbox start {ref}',
    'Exec:',
    '/decide {task-ref} {HD-id} {decision}',
    '/run create-task {description}',
    '/run {skill} {task-ref}'
  ]);
});

test('parseCommand handles built-ins and read-only task commands', () => {
  assert.deepEqual(parseCommand('/ping'), { kind: 'builtin', name: 'ping', role: 'read', args: [] });
  assert.deepEqual(parseCommand('/version'), { kind: 'builtin', name: 'version', role: 'read', args: [] });
  assert.deepEqual(parseCommand('/task status #7'), {
    kind: 'ai',
    role: 'read',
    argv: ['task', 'status', '#7']
  });
});

test('parseCommand maps sandbox and run commands with roles', () => {
  assert.deepEqual(parseCommand('/sandbox create #7'), {
    kind: 'ai',
    role: 'write',
    argv: ['sandbox', 'create', '#7']
  });
  assert.deepEqual(parseCommand('/sandbox rm #7'), {
    kind: 'error',
    message: '/sandbox rm is not available from IM because it requires interactive confirmation'
  });
  assert.deepEqual(parseCommand('/run code-task #7 --tui codex'), {
    kind: 'ai',
    role: 'exec',
    argv: ['run', 'code-task', '#7', '--tui', 'codex']
  });
  assert.deepEqual(parseCommand('/run create-task demo --tui codex'), {
    kind: 'ai',
    role: 'exec',
    argv: ['run', 'create-task', 'demo', '--tui', 'codex']
  });
  assert.deepEqual(parseCommand('/decide #7 HD-1 yes'), {
    kind: 'ai',
    role: 'exec',
    argv: ['decide', '#7', 'HD-1', 'yes']
  });
});

test('parseCommand rejects unknown commands without execution argv', () => {
  assert.equal(parseCommand('hello').kind, 'ignore');
  assert.deepEqual(parseCommand('/unknown'), { kind: 'error', message: 'Unknown command: /unknown' });
});
