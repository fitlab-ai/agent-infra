import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifact-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\ncurrent_step: requirement-analysis-review\n---\n\n# Task\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), '# Analysis\n');
  return { root, id, dir };
}

function run(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-artifact', ...args], { cwd: root, encoding: 'utf8' });
}

function localArtifact(family: 'analysis' | 'plan' | 'code', suffix = ''): string {
  const sections = family === 'analysis'
    ? ['需求来源', '需求理解', '相关文件', '影响评估', '技术风险', '工作量和复杂度评估', '状态核对']
    : family === 'plan'
      ? ['问题理解', '约束条件', '方案对比', '技术方法', '实施步骤', '文件清单', '验证策略', '状态核对']
      : ['实现输入', '变更文件', '关键代码说明', '测试结果', '与方案的差异', '供审查关注的内容'];
  return [
    `# ${family}`,
    ...sections.flatMap((section) => [`## ${section}`, '内容']),
    ...(family === 'code' ? ['## 状态核对', '```text', '$ git status -s', '```', '## 证据原文', '验证输出'] : ['```text', '$ git status -s', '```']),
    suffix
  ].join('\n');
}

test('task-artifact inspect returns one read-only JSON context', () => {
  const f = fixture();
  const before = fs.readdirSync(f.dir).sort();
  const out = run(f.root, [f.id, 'inspect', '--family', 'plan']);
  assert.equal(out.status, 0, `${out.stderr}\n${out.stdout}`);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'ready');
  assert.equal(result.changed, false);
  assert.deepEqual(result.next, { round: 1, name: 'plan.md' });
  assert.equal(result.inputs[0].name, 'analysis.md');
  assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
});

test('task-artifact init creates a non-semantic skeleton and is idempotent', () => {
  const f = fixture();
  const first = run(f.root, [f.id, 'init', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const created = JSON.parse(first.stdout);
  assert.equal(created.status, 'applied');
  const content = fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8');
  assert.match(content, /artifact-context:TASK-20260101-000001:plan:1/);
  assert.equal((content.match(/artifact-section:plan:/g) ?? []).length, 8);

  const before = fs.readFileSync(path.join(f.dir, 'plan.md'));
  const second = run(f.root, [f.id, 'init', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
  assert.equal(JSON.parse(second.stdout).status, 'no-op');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'plan.md')), before);
});

test('task-artifact repair requires the finalizer baseline and changes one heading only', () => {
  const f = fixture();
  const artifact = path.join(f.dir, 'plan.md');
  const sections = ['问题理解', '约束条件', '方案对比', '技术方法', '实施步骤', '文件清单', '验证策略', '状态核对'];
  fs.writeFileSync(artifact, ['# Plan', ...sections.flatMap((section) => [`## ${section}`, 'content']), '```text', '$ git status -s', '```'].join('\n'));
  fs.writeFileSync(artifact, fs.readFileSync(artifact, 'utf8').replace('## 问题理解\n', '## 问题理解：\n'));
  const finalizer = run(f.root, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(finalizer.status, 1, finalizer.stdout);
  const failed = JSON.parse(finalizer.stdout);
  const repaired = run(f.root, [
    f.id, 'repair', '--family', 'plan', '--artifact', 'plan.md',
    '--expected-sha256', failed.artifactSha256,
    '--expected-semantic-digest', failed.semanticDigest
  ]);
  assert.equal(repaired.status, 0, `${repaired.stderr}\n${repaired.stdout}`);
  const result = JSON.parse(repaired.stdout);
  assert.equal(result.status, 'applied');
  assert.equal(fs.readFileSync(artifact, 'utf8').includes('## 问题理解：'), false);
});

test('task-artifact reports usage and domain failures with nonzero exit codes', () => {
  const f = fixture();
  const usage = run(f.root, [f.id, 'inspect', '--family']);
  assert.equal(usage.status, 2);
  assert.equal(JSON.parse(usage.stdout).error.code, 'ARTIFACT_PAYLOAD_INVALID');
  const unknown = run(f.root, [f.id, 'inspect', '--family', 'unknown']);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'ARTIFACT_FAMILY_UNKNOWN');
});

test('task-artifact finalize-local returns stable digests without mutating a valid artifact', () => {
  const f = fixture();
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, localArtifact('plan'));
  const before = fs.readFileSync(artifact);

  const out = run(f.root, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);

  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'passed');
  assert.equal(result.changed, false);
  assert.match(result.artifactSha256, /^[0-9a-f]{64}$/);
  assert.match(result.semanticDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readFileSync(artifact), before);
});

test('task-artifact finalize-local uses repository config from a nested working directory', () => {
  const f = fixture();
  const sections = ['Problem Understanding', 'Constraints', 'Options Comparison', 'Technical Approach', 'Implementation Steps', 'File List', 'Verification Strategy', 'State Check'];
  const configDir = path.join(f.root, '.agents', 'skills', 'plan-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    checks: { artifact: { required_sections: sections, required_patterns: ['^\\$ '] } }
  }));
  fs.writeFileSync(path.join(f.dir, 'plan.md'), [
    '# Technical Plan',
    ...sections.flatMap((section) => [`## ${section}`, 'content']),
    '```text',
    '$ git status -s',
    '```'
  ].join('\n'));
  const nested = path.join(f.root, 'nested');
  fs.mkdirSync(nested);

  const out = run(nested, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);

  assert.equal(out.status, 0, `${out.stderr}\n${out.stdout}`);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.diagnostics, []);
});

test('task-artifact finalize-local reports one-line heading repair and revalidates after the edit', () => {
  const f = fixture();
  const artifact = path.join(f.dir, 'analysis.md');
  fs.writeFileSync(artifact, localArtifact('analysis').replace('## 需求来源\n', '## 需求来源：\n'));

  const failed = run(f.root, [f.id, 'finalize-local', '--family', 'analysis', '--artifact', 'analysis.md']);
  assert.equal(failed.status, 1);
  const failure = JSON.parse(failed.stdout);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.repairable, true);
  assert.equal(failure.diagnostics[0].code, 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION');
  assert.equal(failure.diagnostics[0].operation, 'replace-line');
  assert.equal(failure.diagnostics[0].from, '需求来源：');
  assert.equal(failure.diagnostics[0].to, '需求来源');

  fs.writeFileSync(artifact, fs.readFileSync(artifact, 'utf8').replace('## 需求来源：\n', '## 需求来源\n'));
  const passed = run(f.root, [f.id, 'finalize-local', '--family', 'analysis', '--artifact', 'analysis.md']);
  assert.equal(passed.status, 0, passed.stderr);
  const success = JSON.parse(passed.stdout);
  assert.equal(success.status, 'passed');
  assert.equal(success.semanticDigest, failure.semanticDigest);
});

test('task-artifact finalize-local supports code reports and preserves the repair baseline', () => {
  const f = fixture();
  const artifact = path.join(f.dir, 'code.md');
  fs.writeFileSync(artifact, localArtifact('code').replace('## 测试结果\n', '## 测试结果：\n'));

  const failed = run(f.root, [f.id, 'finalize-local', '--family', 'code', '--artifact', 'code.md']);
  assert.equal(failed.status, 1);
  const failure = JSON.parse(failed.stdout);
  assert.equal(failure.repairable, true);
  assert.equal(failure.diagnostics[0].code, 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION');

  fs.writeFileSync(artifact, fs.readFileSync(artifact, 'utf8').replace('## 测试结果：', '## 测试结果'));
  const passed = run(f.root, [f.id, 'finalize-local', '--family', 'code', '--artifact', 'code.md']);
  assert.equal(passed.status, 0, passed.stderr);
  const success = JSON.parse(passed.stdout);
  assert.equal(success.status, 'passed');
  assert.equal(success.semanticDigest, failure.semanticDigest);
});

test('task-artifact finalize-local ignores fenced headings and commands', () => {
  const f = fixture();
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, [
    '# plan',
    '```markdown',
    '## 问题理解',
    '```',
    '## 约束条件',
    '内容',
    '## 方案对比',
    '内容',
    '## 技术方法',
    '内容',
    '## 实施步骤',
    '内容',
    '## 文件清单',
    '内容',
    '## 验证策略',
    '内容',
    '## 状态核对',
    '```text',
    '$ git status -s',
    '```'
  ].join('\n'));

  const out = run(f.root, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(out.status, 1);
  const result = JSON.parse(out.stdout);
  assert.equal(result.repairable, false);
  assert.ok(result.diagnostics.some((item: { code: string }) => item.code === 'LOCAL_ARTIFACT_MISSING_SECTION'));
});
