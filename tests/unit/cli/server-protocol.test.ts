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
    '/task decisions [--task {ref} | -t {ref}] [--item {selector} | -i {selector}]',
    '/task log [--task {ref} | -t {ref}]',
    '/task ls',
    '/task show [--task {ref} | -t {ref}]',
    '/task status [--task {ref} | -t {ref}]',
    'Write:',
    '/sandbox create {ref}',
    '/sandbox start {ref}',
    'Exec:',
    '/decide [--task {ref} | -t {ref}] (--item {ordinal|ledger-id} | -i {ordinal|ledger-id}) [--needs-implementation true|false] {decision}',
    '/run create-task {description}',
    '/run {skill} {task-ref}'
  ]);
});

test('parseCommand handles built-ins and read-only task commands', () => {
  assert.deepEqual(parseCommand('/ping'), { kind: 'builtin', name: 'ping', role: 'read', args: [] });
  assert.deepEqual(parseCommand('/version'), { kind: 'builtin', name: 'version', role: 'read', args: [] });
  assert.deepEqual(parseCommand('/task status --task #7'), {
    kind: 'ai',
    role: 'read',
    argv: ['task', 'status', '--task', '#7']
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
  assert.deepEqual(parseCommand('/run code-task 7 --tui codex'), {
    kind: 'ai',
    role: 'exec',
    argv: ['run', '--skill', 'code-task', '--task', '7', '--tui', 'codex']
  });
  assert.deepEqual(parseCommand('/run create-task demo --tui codex'), {
    kind: 'ai',
    role: 'exec',
    argv: ['run', '--skill', 'create-task', 'demo', '--tui', 'codex']
  });
  assert.deepEqual(parseCommand('/decide --task #7 --item PL-1 yes'), {
    kind: 'ai',
    role: 'exec',
    argv: ['decide', '--task', '#7', '--item', 'PL-1', 'yes']
  });
  assert.deepEqual(parseCommand('/decide -t #7 -i CD-1 --needs-implementation true yes'), {
    kind: 'ai',
    role: 'exec',
    argv: ['decide', '-t', '#7', '-i', 'CD-1', '--needs-implementation', 'true', 'yes']
  });
});

test('parseCommand rejects unknown commands without execution argv', () => {
  assert.equal(parseCommand('hello').kind, 'ignore');
  assert.deepEqual(parseCommand('/unknown'), { kind: 'error', message: 'Unknown command: /unknown' });
});
