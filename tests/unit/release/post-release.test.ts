import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeDemoInputDigest, runOptionalDemo } from '../../../lib/internal/release-workflow.ts';
import type { CommandRunner } from '../../../lib/internal/release-workflow.ts';

function result(status: number, stdout = '', stderr = '') {
  return { status, stdout, stderr, pid: 1, signal: null, output: [], error: undefined };
}

const inputs = [
  'assets/demo-init.tape', 'scripts/demo-regen.sh', 'scripts/normalize-gif-duration.py',
  'bin/cli.ts', 'lib/init.ts', 'lib/log.ts', 'lib/prompt.ts', 'lib/paths.ts',
  'lib/render.ts', 'lib/builtin-tuis.ts', 'lib/sandbox/engines/index.ts',
  'src/sync-templates.js', 'templates/AGENTS.md'
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-'));
  for (const file of inputs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  return root;
}

function recorder(calls: string[]): CommandRunner {
  return (cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    if (executable === 'git' && args[0] === 'check-attr') return result(0, 'assets/demo-init.gif: filter: lfs\n');
    if (executable === 'git' && args[1] === 'pointer') return result(0, 'size 6\n');
    if (executable === 'npm') {
      fs.writeFileSync(path.join(cwd, 'assets/demo-init.gif'), Buffer.from('GIF89a'));
    }
    return result(0);
  };
}

test('demo input digest is stable and changes for canonical UX inputs', () => {
  const root = fixture();
  try {
    const initial = computeDemoInputDigest(root);
    assert.equal(computeDemoInputDigest(root), initial);
    fs.appendFileSync(path.join(root, 'lib/prompt.ts'), 'changed');
    assert.notEqual(computeDemoInputDigest(root), initial);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged demo inputs skip recorder and tool probes', () => {
  const root = fixture();
  const calls: string[] = [];
  try {
    fs.writeFileSync(path.join(root, 'assets/demo-init.inputs.sha256'), `${computeDemoInputDigest(root)}\n`);
    assert.deepEqual(runOptionalDemo(root, recorder(calls)), {
      status: 'skipped', reasonCode: 'DEMO_INPUTS_UNCHANGED', message: null, outputPath: null
    });
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changed demo inputs record after LFS and media tool probes and advance the digest', () => {
  const root = fixture();
  const calls: string[] = [];
  try {
    assert.deepEqual(runOptionalDemo(root, recorder(calls)), {
      status: 'recorded', reasonCode: null, message: null, outputPath: 'assets/demo-init.gif'
    });
    assert.deepEqual(calls, [
      'git lfs version',
      'git check-attr filter -- assets/demo-init.gif',
      'vhs --version',
      'ffmpeg -version',
      'npm run demo:regen',
      'git lfs pointer --file=assets/demo-init.gif'
    ]);
    assert.equal(fs.readFileSync(path.join(root, 'assets/demo-init.inputs.sha256'), 'utf8'), `${computeDemoInputDigest(root)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed recording does not advance the demo digest', () => {
  const root = fixture();
  const run: CommandRunner = (_cwd, executable) =>
    executable === 'npm' ? result(1, '', 'recording failed')
      : executable === 'git' ? result(0, 'assets/demo-init.gif: filter: lfs\n') : result(0);
  try {
    assert.equal(runOptionalDemo(root, run).reasonCode, 'DEMO_COMMAND_FAILED');
    assert.equal(fs.existsSync(path.join(root, 'assets/demo-init.inputs.sha256')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing Git LFS fails before recording tools are probed', () => {
  const root = fixture();
  const calls: string[] = [];
  const run: CommandRunner = (_cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    return result(1, '', 'missing');
  };
  try {
    assert.equal(runOptionalDemo(root, run).reasonCode, 'GIT_LFS_MISSING');
    assert.deepEqual(calls, ['git lfs version']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid demo output fails without advancing the digest', () => {
  const root = fixture();
  const run: CommandRunner = (cwd, executable) => {
    if (executable === 'npm') fs.writeFileSync(path.join(cwd, 'assets/demo-init.gif'), 'not gif');
    return executable === 'git' ? result(0, 'assets/demo-init.gif: filter: lfs\n') : result(0);
  };
  try {
    assert.equal(runOptionalDemo(root, run).reasonCode, 'DEMO_OUTPUT_INVALID');
    assert.equal(fs.existsSync(path.join(root, 'assets/demo-init.inputs.sha256')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
