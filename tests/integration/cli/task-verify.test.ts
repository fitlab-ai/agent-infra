import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { filePath, INTERNAL_CLI_PATH } from '../../helpers.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

function boundFact(number = 42, branch = 'feature', state: 'open' | 'closed' = 'open') {
  return encodePrDeliveryFact(buildBoundFact({
    identity: { resource: { kind: 'number', value: number }, repository: 'fitlab-ai/agent-infra', url: `https://github.com/fitlab-ai/agent-infra/pull/${number}`, head: { repository: 'fitlab-ai/agent-infra', ref: branch, sha: 'a'.repeat(40) }, base: { repository: 'fitlab-ai/agent-infra', ref: 'main', sha: 'b'.repeat(40) } },
    source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: state,
    ...(state === 'closed' ? { mergedAt: '2026-08-01T00:00:00Z', mergeCommitSha: 'c'.repeat(40) } : {})
  }));
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

test('internal task-verify resolves task identity and invokes the typed engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verify-integration-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const id = 'TASK-20260101-000001';
    const dir = path.join(root, '.agents', 'workspace', 'active', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ prFlow: 'disabled' }));
    fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\n---\n`);
    fs.writeFileSync(path.join(dir, 'code.md'), '# Code\n');
    writeJson(path.join(root, '.agents/skills/code-task/config/verify.json'), { skill: 'code-task', checks: {} });
    writeJson(path.join(root, '.agents/skills/complete-task/config/verify.json'), {
      skill: 'complete-task', checks: { 'required-pr-delivery': {} }
    });

    const pass = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'code.completed', '--artifact', 'code.md', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /Verification: pass \| Skill: code-task/);

    const preflight = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'complete-task.preflight', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal((preflight.stdout.match(/^Check: pass/gm) ?? []).length, 1);

    const duplicate = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'commit.completed', '--format', 'json', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(duplicate.status, 1);
    assert.equal(JSON.parse(duplicate.stdout).error.code, 'VERIFY_PAYLOAD_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('code artifact verification applies the local structural contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verify-code-artifact-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const id = 'TASK-20260101-000001';
    const dir = path.join(root, '.agents', 'workspace', 'active', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\n---\n`);
    fs.writeFileSync(path.join(dir, 'code.md'), fs.readFileSync('tests/fixtures/validate-artifact/valid-code.md'));
    writeJson(path.join(root, '.agents/skills/code-task/config/verify.json'), {
      skill: 'code-task', checks: {
        artifact: {
          file_pattern: 'code.md|code-r{N}.md',
          required_sections: ['实现输入', '变更文件', '关键代码说明', '测试结果', '与方案的差异', '供审查关注的内容', '状态核对', '证据原文'],
          required_patterns: ['^\\$ ']
        }
      }
    });

    const passed = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'code.completed', '--artifact', 'code.md', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /Verification: pass \| Skill: code-task/);

    fs.writeFileSync(path.join(dir, 'code.md'), fs.readFileSync(path.join(dir, 'code.md'), 'utf8').replace('## 测试结果', '## 测试结果：'));
    const failed = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'code.completed', '--artifact', 'code.md', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('required PR delivery gates on normalized merged state and platform availability', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'required-pr-delivery-'));
  const id = 'TASK-20260101-000001';
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const dir = path.join(root, '.agents', 'workspace', 'active', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ platform: { type: 'github' }, delivery: { remote: 'origin', baseRef: 'main' }, prFlow: 'required' }));
    writeJson(path.join(root, '.agents/skills/complete-task/config/verify.json'), {
      skill: 'complete-task', checks: { 'required-pr-delivery': {} }
    });
    fs.writeFileSync(path.join(dir, 'task.md'), [
      '---', `id: ${id}`, 'status: active', `pr_delivery_fact: ${JSON.stringify(boundFact(42, 'feature'))}`, 'branch: feature', '---', ''
    ].join('\n'));
    const prPath = path.join(root, 'pr.json');
    fs.writeFileSync(prPath, JSON.stringify({
      number: 42, node_id: 'PR_42', html_url: 'https://github.com/fitlab-ai/agent-infra/pull/42',
      state: 'open', title: 'Fixture', body: '', draft: false,
      head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
      merged_at: null, merge_commit_sha: null
    }));
    const fake = path.join(root, 'fake-gh.cjs');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    const env = {
      ...process.env,
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_PR_PATH: prPath
    };
    const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(
      process.execPath,
      [INTERNAL_CLI_PATH, 'task-verify', id, 'complete-task.hard-preflight', '--format', 'json'],
      { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }
    );

    const open = run();
    assert.equal(open.status, 1, `${open.stderr}\n${open.stdout}`);
    assert.equal(JSON.parse(open.stdout).invocations[0].status, 'fail');

    fs.writeFileSync(prPath, JSON.stringify({
      number: 42, node_id: 'PR_42', html_url: 'https://github.com/fitlab-ai/agent-infra/pull/42',
      state: 'closed', title: 'Fixture', body: '', draft: false,
      head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
      merged_at: '2026-08-01T00:00:00Z', merge_commit_sha: 'c'.repeat(40)
    }));
    const merged = run();
    assert.equal(merged.status, 0, merged.stderr || merged.stdout);
    assert.equal(JSON.parse(merged.stdout).invocations[0].status, 'pass');

    const taskPath = path.join(dir, 'task.md');
    const beforeMismatch = fs.readFileSync(taskPath, 'utf8');
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ platform: { type: 'github' }, delivery: { remote: 'origin', baseRef: 'release' }, prFlow: 'required' }));
    const mismatchedBase = run();
    assert.equal(mismatchedBase.status, 1, mismatchedBase.stderr || mismatchedBase.stdout);
    assert.equal(JSON.parse(mismatchedBase.stdout).invocations[0].status, 'fail');
    assert.equal(fs.readFileSync(taskPath, 'utf8'), beforeMismatch);

    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ platform: { type: 'github' }, delivery: { remote: 'origin', baseRef: 'main' }, prFlow: 'required' }));
    const unavailable = run({ GH_FAKE_FAIL: 'network unavailable' });
    assert.equal(unavailable.status, 2);
    assert.equal(JSON.parse(unavailable.stdout).invocations[0].status, 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review-pr task-verify gate requires re-sync after publication write-back (PL-8)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pr-verify-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const id = 'TASK-20260101-000001';
    const dir = path.join(root, '.agents', 'workspace', 'active', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
    const head = 'a'.repeat(40);
    fs.writeFileSync(path.join(dir, 'task.md'), [
      `---`,
      `id: ${id}`,
      `type: feature`,
      `status: active`,
      `issue_number: 7`,
      `pr_delivery_fact: ${JSON.stringify(boundFact(42))}`,
      `---`,
      ``,
      `# 任务`,
      ``,
      `## 活动日志`,
      ``,
      `- 2026-08-04 19:30:00+08:00 — **Review PR (Round 1) [started]** by claude — started`,
      `- 2026-08-04 20:00:00+08:00 — **Review PR (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0 → pr-review.md`,
      ``
    ].join('\n'));
    const artifactContent = [
      `# PR 审查报告`,
      ``,
      `## 状态核对`,
      ``,
      `$ agent-infra-internal task-snapshot ${id} --format text`,
      ``,
      `## 身份信息`,
      ``,
      `- **PR 编号**：42`,
      ``,
      `## 证据清单`,
      ``,
      `- **被审 head SHA**：${head}`,
      `- **审查模式**：verify`,
      `- **证据场景**：S1`,
      `- **receipt**：r1-abc`,
      ``,
      `## 覆盖矩阵`,
      ``,
      `| 检视面 | 证据 | 结论 | 未覆盖/缺口 |`,
      `|--------|------|------|-------------|`,
      `| 需求边界 | 证据 | 结论 | 缺口 |`,
      ``,
      `## 问题清单`,
      ``,
      `（无）`,
      ``,
      `## 发布结果`,
      ``,
      `- **正式 Review 状态**：applied`,
      ``,
      `## 证据原文`,
      ``,
      `$ echo verified`,
      ``
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'pr-review.md'), artifactContent);

    writeJson(path.join(root, '.agents/skills/review-pr/config/verify.json'),
      JSON.parse(fs.readFileSync('.agents/skills/review-pr/config/verify.json', 'utf8')));

    const commentsPath = path.join(root, 'comments.json');
    fs.writeFileSync(commentsPath, '[]');
    const issuePath = path.join(root, 'issue.json');
    fs.writeFileSync(issuePath, JSON.stringify({
      number: 7, state: 'open', title: 'Test issue', body: 'Issue body',
      labels: [], milestone: null, type: { name: 'Task' }
    }));
    const fakeGhPath = path.join(root, 'fake-gh.cjs');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fakeGhPath);
    const env = {
      ...process.env,
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fakeGhPath]),
      GH_FAKE_COMMENTS_PATH: commentsPath,
      GH_FAKE_ISSUE_NUMBER: '7',
      GH_FAKE_ISSUE_PATH: issuePath
    };
    const run = (args: string[]) => spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], { cwd: root, env, encoding: 'utf8' });

    // Step 4: first sync of task + artifact comments (snapshot of the original artifact).
    const taskSync = run(['platform-comment', 'sync', id, '--kind', 'task', '--agent', 'claude-code']);
    assert.equal(taskSync.status, 0, taskSync.stderr || taskSync.stdout);
    const artifactSync = run(['platform-comment', 'sync', id, '--kind', 'artifact', '--artifact', 'pr-review.md', '--agent', 'claude-code']);
    assert.equal(artifactSync.status, 0, artifactSync.stderr || artifactSync.stdout);
    assert.equal(JSON.parse(artifactSync.stdout).status, 'applied');

    // Step 6 write-back: rewrite the local artifact Publication Result section.
    fs.writeFileSync(path.join(dir, 'pr-review.md'),
      artifactContent.replace('- **正式 Review 状态**：applied', '- **正式 Review 状态**：applied\n- **Review URL**：https://github.com/fitlab-ai/agent-infra/pull/42'));

    // Control: verifying WITHOUT re-sync must fail with a content mismatch.
    const before = run(['task-verify', id, 'review-pr.completed', '--artifact', 'pr-review.md', '--format', 'text']);
    assert.equal(before.status, 1, before.stdout);
    assert.match(before.stdout, /Comment content mismatch/);

    // Step 7: re-sync the artifact comment to align local and remote.
    const reSync = run(['platform-comment', 'sync', id, '--kind', 'artifact', '--artifact', 'pr-review.md', '--agent', 'claude-code']);
    assert.equal(reSync.status, 0, reSync.stderr || reSync.stdout);
    assert.equal(JSON.parse(reSync.stdout).status, 'applied');

    // Step 8: after re-sync the closed loop passes.
    const after = run(['task-verify', id, 'review-pr.completed', '--artifact', 'pr-review.md', '--format', 'text']);
    assert.equal(after.status, 0, after.stdout);
    assert.match(after.stdout, /Verification: pass \| Skill: review-pr/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
