import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalTaskCreateCandidate, validateTaskCreateCandidate } from '../../../lib/task/create.ts';

const internalCli = path.resolve('bin/internal-cli.ts');
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_INFRA_CONTROL_'))
);

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-task-create-cli-'));
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'demo', task: { shortIdLength: 2 }, platform: { type: null }, delivery: { remote: 'origin', baseRef: 'main' } }));
  fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
  fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  return root;
}

function candidate() {
  return {
    version: 1,
    idempotencyKey: '12345678-1234-4123-8123-123456789abc',
    agent: 'codex',
    title: 'Create through internal CLI',
    type: 'feature',
    branchSlug: 'create-through-internal-cli',
    priority: 'Medium',
    effort: 'Low',
    description: 'Create a task through the deterministic host command.',
    taskInput: {
      sources: ['Integration test'], facts: [], constraints: [], decisions: [], alternatives: [],
      acceptanceCriteria: ['A task is persisted.'], openQuestions: []
    }
  };
}

test('task-create internal CLI persists a task and replays as no-op', () => {
  const root = fixture();
  const input = path.join(root, 'candidate.json');
  fs.writeFileSync(input, JSON.stringify(candidate()));
  try {
    const first = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const applied = JSON.parse(first.stdout);
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.operations.at(-1), { name: 'task:verify', status: 'pass', reasonCode: null });
    assert.match(applied.task.id, /^TASK-\d{8}-\d{6}$/);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'active', applied.task.id, 'task.md')), true);

    const second = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const replayed = JSON.parse(second.stdout);
    assert.equal(replayed.status, 'no-op');
    assert.equal(replayed.task.id, applied.task.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-create formats non-user tokens in title, description and every input field without changing the raw candidate digest', () => {
  const root = fixture();
  const input = path.join(root, 'candidate.json');
  const raw = {
    ...candidate(),
    title: 'Optical detail @2x',
    description: 'Description @2x',
    taskInput: {
      sources: ['source @2x'],
      facts: ['fact @2x'],
      constraints: ['constraint @2x'],
      decisions: ['decision @2x'],
      alternatives: ['alternative @2x'],
      acceptanceCriteria: ['acceptance @2x'],
      openQuestions: ['question @2x']
    }
  };
  const expectedDigest = createHash('sha256')
    .update(canonicalTaskCreateCandidate(validateTaskCreateCandidate(raw)))
    .digest('hex');
  fs.writeFileSync(input, JSON.stringify(raw));
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const taskId = JSON.parse(result.stdout).task.id as string;
    const task = fs.readFileSync(path.join(root, '.agents', 'workspace', 'active', taskId, 'task.md'), 'utf8');
    assert.match(task, /^# 任务：Optical detail `@2x`$/m);
    assert.match(task, /Description `@2x`/);
    for (const field of ['source', 'fact', 'constraint', 'decision', 'alternative', 'acceptance', 'question']) {
      assert.match(task, new RegExp('^- ' + field + ' `@2x`$', 'm'));
    }
    assert.match(task, new RegExp(`^task_create_candidate_digest: ${expectedDigest}$`, 'm'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-create internal CLI rejects symbolic-link input without writing', () => {
  const root = fixture();
  const real = path.join(root, 'candidate.json');
  const linked = path.join(root, 'candidate-link.json');
  fs.writeFileSync(real, JSON.stringify(candidate()));
  fs.symlinkSync(real, linked);
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', linked], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'TASK_CREATE_INPUT_INVALID');
    assert.deepEqual(fs.readdirSync(path.join(root, '.agents', 'workspace', 'active')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
