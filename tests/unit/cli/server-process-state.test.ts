import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildProcessStartTimeQuery,
  getProcessStartTime,
  parseLinuxProcessStat,
  readProcessState,
  removePidFileIfMatches,
  writePidRecord
} from '../../../lib/server/process-state.ts';

test('parseLinuxProcessStat handles spaces and closing parentheses in comm', () => {
  const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '987654', '0'];
  assert.deepEqual(parseLinuxProcessStat(`42 (worker ) name) ${fields.join(' ')}`), {
    state: 'S',
    startTime: '987654'
  });
  assert.equal(parseLinuxProcessStat(`42 (worker) ${['Z', ...fields.slice(1)].join(' ')}`)?.state, 'Z');
  assert.equal(parseLinuxProcessStat('not a proc stat line'), null);
});

test('buildProcessStartTimeQuery uses argv without a shell on macOS and Windows', () => {
  assert.deepEqual(buildProcessStartTimeQuery(4321, 'darwin'), {
    command: 'ps',
    args: ['-p', '4321', '-o', 'lstart=']
  });

  const windows = buildProcessStartTimeQuery(4321, 'win32');
  assert.equal(windows?.command, 'powershell.exe');
  assert.deepEqual(windows?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(windows?.args[3] ?? '', /ProcessId = 4321/);
  assert.equal(buildProcessStartTimeQuery(4321, 'linux'), null);
});

test('readProcessState classifies missing, invalid, legacy, mismatch, and matching records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-process-state-'));
  const pidFile = path.join(dir, 'server.pid');
  try {
    assert.equal(readProcessState(pidFile).kind, 'missing');

    fs.writeFileSync(pidFile, 'not-a-pid\n');
    const invalid = readProcessState(pidFile);
    assert.equal(invalid.kind, 'invalid');
    assert.equal(removePidFileIfMatches(pidFile, invalid.snapshot), true);
    assert.equal(fs.existsSync(pidFile), false);

    fs.writeFileSync(pidFile, `${process.pid}\n`);
    const legacy = readProcessState(pidFile);
    assert.equal(legacy.kind, 'legacy');
    assert.equal(legacy.pid, process.pid);

    const startTime = getProcessStartTime(process.pid);
    assert.ok(startTime !== null, 'the current process start time should be queryable');
    writePidRecord(pidFile, { version: 1, pid: process.pid, startTime: `${startTime}-mismatch` });
    assert.equal(readProcessState(pidFile).kind, 'stale');

    writePidRecord(pidFile, { version: 1, pid: process.pid, startTime });
    const running = readProcessState(pidFile);
    assert.equal(running.kind, 'running');
    assert.equal(running.record.pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conditional cleanup preserves a replaced pid record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-process-state-race-'));
  const pidFile = path.join(dir, 'server.pid');
  try {
    fs.writeFileSync(pidFile, '123\n');
    const oldState = readProcessState(pidFile);
    fs.writeFileSync(pidFile, '456\n');

    assert.equal(removePidFileIfMatches(pidFile, oldState.snapshot), false);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '456\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
