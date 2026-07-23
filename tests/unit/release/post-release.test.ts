import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runOptionalDemo } from '../../../lib/internal/release-workflow.ts';
import type { CommandRunner } from '../../../lib/internal/release-workflow.ts';

function result(status: number, stdout = '', stderr = '') {
  return { status, stdout, stderr, pid: 1, signal: null, output: [], error: undefined };
}

test('optional release demo records only after both tools are available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-'));
  const calls: string[] = [];
  const run: CommandRunner = (cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    if (executable === 'npm') {
      fs.mkdirSync(path.join(cwd, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'assets/demo-init.gif'), 'gif');
    }
    return result(0);
  };
  try {
    assert.deepEqual(runOptionalDemo(root, run), {
      status: 'recorded', reasonCode: null, message: null, outputPath: 'assets/demo-init.gif'
    });
    assert.deepEqual(calls, ['vhs --version', 'ffmpeg -version', 'npm run demo:regen']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('optional release demo skips a missing recorder without running npm', () => {
  const calls: string[] = [];
  const run: CommandRunner = (_cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    return result(executable === 'vhs' ? 1 : 0);
  };
  assert.deepEqual(runOptionalDemo('/repo', run), {
    status: 'skipped', reasonCode: 'VHS_MISSING', message: null, outputPath: null
  });
  assert.deepEqual(calls, ['vhs --version']);
});

test('optional release demo skips a missing encoder without running npm', () => {
  const calls: string[] = [];
  const run: CommandRunner = (_cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    return result(executable === 'ffmpeg' ? 1 : 0);
  };
  assert.deepEqual(runOptionalDemo('/repo', run), {
    status: 'skipped', reasonCode: 'FFMPEG_MISSING', message: null, outputPath: null
  });
  assert.deepEqual(calls, ['vhs --version', 'ffmpeg -version']);
});

test('optional release demo preserves a definite recording failure', () => {
  const run: CommandRunner = (_cwd, executable) =>
    executable === 'npm' ? result(1, '', 'recording failed') : result(0);
  assert.deepEqual(runOptionalDemo('/repo', run), {
    status: 'failed', reasonCode: 'DEMO_COMMAND_FAILED', message: 'recording failed', outputPath: null
  });
});

test('optional release demo fails when the recorder does not produce the project GIF', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-missing-'));
  const run: CommandRunner = () => result(0);
  try {
    assert.deepEqual(runOptionalDemo(root, run), {
      status: 'failed',
      reasonCode: 'DEMO_OUTPUT_MISSING',
      message: 'assets/demo-init.gif was not generated',
      outputPath: null
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
