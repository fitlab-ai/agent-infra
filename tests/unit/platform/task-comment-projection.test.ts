import test from 'node:test';
import assert from 'node:assert/strict';

import { projectTaskComment } from '../../../lib/platform/task-comment-projection.ts';

test('task comment projection keeps the current snapshot and excludes workflow history', () => {
  const content = [
    '---',
    'id: TASK-20260101-000001',
    'type: bugfix',
    'status: active',
    'current_step: code',
    'code_input_sha256: deadbeef',
    '---',
    '',
    '# 任务：恢复任务',
    '',
    '## 描述',
    '当前描述。',
    '',
    '## 需求',
    '- [ ] 保留当前行为',
    '',
    '## 活动日志',
    '- 2026-01-01 — **Code Task** by codex — completed',
    '',
    '## 产物收据',
    '| event | output |',
    '',
    '## 工作流告警',
    '| id | message |'
  ].join('\n');

  const projection = projectTaskComment(content);

  assert.match(projection.content, /^---\nid: TASK-20260101-000001\ntype: bugfix\nstatus: active\ncurrent_step: code\n---/);
  assert.match(projection.content, /## 描述\n当前描述。/);
  assert.match(projection.content, /## 需求\n- \[ \] 保留当前行为/);
  assert.equal(projection.content.includes('code_input_sha256'), false);
  assert.equal(projection.content.includes('## 活动日志'), false);
  assert.equal(projection.content.includes('## 产物收据'), false);
  assert.equal(projection.content.includes('## 工作流告警'), false);
  assert.equal(projection.byteLength, Buffer.byteLength(projection.content, 'utf8'));
  assert.match(projection.sha256, /^[a-f0-9]{64}$/);
});

test('task comment projection fails when the document has no frontmatter', () => {
  assert.throws(() => projectTaskComment('# Task\n'), /frontmatter/);
});
