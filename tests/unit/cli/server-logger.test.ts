import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../../../lib/server/logger.ts';

function tmpLog(): { dir: string; logPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-logger-'));
  return { dir, logPath: path.join(dir, 'nested', 'server.log') };
}

test('createLogger appends level-prefixed lines and creates the parent directory', () => {
  const { dir, logPath } = tmpLog();
  try {
    const logger = createLogger({ path: logPath, rotateAtBytes: 1_000_000 });
    logger.info('hello');
    logger.ok('ready');
    logger.err('oops');
    logger.close();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /^\[[^\]]+\] \[INFO\] hello$/);
    assert.match(lines[1] ?? '', /^\[[^\]]+\] \[OK\] ready$/);
    assert.match(lines[2] ?? '', /^\[[^\]]+\] \[ERROR\] oops$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized existing log is rotated to .1 on startup', () => {
  const { dir, logPath } = tmpLog();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'X'.repeat(200));

    const logger = createLogger({ path: logPath, rotateAtBytes: 100 });
    logger.info('after rotation');
    logger.close();

    assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'X'.repeat(200), 'old content moves to .1');
    const current = fs.readFileSync(logPath, 'utf8');
    assert.doesNotMatch(current, /X{200}/);
    assert.match(current, /\[INFO\] after rotation/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log under the threshold is not rotated', () => {
  const { dir, logPath } = tmpLog();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'small');

    const logger = createLogger({ path: logPath, rotateAtBytes: 1_000_000 });
    logger.info('appended');
    logger.close();

    assert.equal(fs.existsSync(`${logPath}.1`), false, 'no rotation file created');
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /^small/);
    assert.match(content, /\[INFO\] appended/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
