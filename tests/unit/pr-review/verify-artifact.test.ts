import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';

const HEAD = 'a'.repeat(40);

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-artifact-'));
  const configDir = path.join(root, '.agents', 'skills', 'review-pr', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(path.resolve('templates/.agents/skills/review-pr/config/verify.zh-CN.json'), path.join(configDir, 'verify.json'));
  return root;
}

function validArtifact(): string {
  return [
    '# PR 审查报告',
    '',
    '## 状态核对',
    '',
    '$ agent-infra-internal task-snapshot TASK-1 --format text',
    '',
    '## 身份信息',
    '',
    '- **PR 编号**：42',
    '',
    '## 证据清单',
    '',
    `- **被审 head SHA**：${HEAD}`,
    '- **审查模式**：verify',
    '- **证据场景**：S1',
    '- **receipt**：r1-abc',
    '',
    '## 覆盖矩阵',
    '',
    '| 检视面 | 证据 | 结论 | 未覆盖/缺口 |',
    '|--------|------|------|-------------|',
    '| 需求边界 | 证据 | 结论 | 缺口 |',
    '',
    '## 问题清单',
    '',
    '（无）',
    '',
    '## 发布结果',
    '',
    '- **正式 Review 状态**：applied',
    '',
    '## 证据原文',
    '',
    '$ echo verified',
    ''
  ].join('\n');
}

function runVerify(root: string, fileName: string, content: string) {
  const artifactPath = path.join(root, fileName);
  fs.writeFileSync(artifactPath, content);
  return verifyInProcess({
    mode: 'checks',
    skillName: 'review-pr',
    taskDir: root,
    artifactFile: fileName,
    checks: ['artifact'],
    repositoryRoot: root
  }) as { status: 'pass' | 'fail' | 'blocked'; message: string };
}

test('verify-artifact passes a complete standalone pr-review artifact without task context', () => {
  const root = fixtureRoot();
  try {
    const result = runVerify(root, 'pr-review.md', validArtifact());
    assert.equal(result.status, 'pass', result.message);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-artifact fails when the reviewed head SHA is missing', () => {
  const root = fixtureRoot();
  try {
    const content = validArtifact().replace(`- **被审 head SHA**：${HEAD}\n`, '');
    const result = runVerify(root, 'pr-review.md', content);
    assert.equal(result.status, 'fail');
    assert.match(result.message, /required pattern/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-artifact fails when the evidence scenario is missing', () => {
  const root = fixtureRoot();
  try {
    const content = validArtifact().replace('- **证据场景**：S1\n', '');
    const result = runVerify(root, 'pr-review.md', content);
    assert.equal(result.status, 'fail');
    assert.match(result.message, /required pattern/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-artifact fails when the review mode is missing', () => {
  const root = fixtureRoot();
  try {
    const content = validArtifact().replace('- **审查模式**：verify\n', '');
    const result = runVerify(root, 'pr-review.md', content);
    assert.equal(result.status, 'fail');
    assert.match(result.message, /required pattern/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-artifact fails when the receipt is missing', () => {
  const root = fixtureRoot();
  try {
    const content = validArtifact().replace('- **receipt**：r1-abc\n', '');
    const result = runVerify(root, 'pr-review.md', content);
    assert.equal(result.status, 'fail');
    assert.match(result.message, /required pattern/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-artifact reports missing required sections', () => {
  const root = fixtureRoot();
  try {
    const content = validArtifact().replace('## 覆盖矩阵', '## 缺失的段');
    const result = runVerify(root, 'pr-review.md', content);
    assert.equal(result.status, 'fail');
    assert.match(result.message, /missing sections/);
    assert.match(result.message, /覆盖矩阵/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
