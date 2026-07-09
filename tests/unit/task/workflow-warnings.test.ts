import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOpenWorkflowWarnings,
  parseWorkflowWarnings,
  formatWorkflowWarningSummary
} from '../../../lib/task/workflow-warnings.ts';

test('parseWorkflowWarnings reads Chinese and English warning sections', () => {
  const zh = [
    '# 任务',
    '',
    '## 工作流告警',
    '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '| WW-1 | 2026-07-09 12:00:00+08:00 | create-task | ACTION_REQUIRED | ISSUE_CREATE_FAILED | open | issue | message | retry auth |  |  |'
  ].join('\n');
  const en = zh.replace('## 工作流告警', '## Workflow Warnings');

  assert.equal(parseWorkflowWarnings(zh).length, 1);
  assert.equal(parseWorkflowWarnings(en).length, 1);
});

test('parseWorkflowWarnings restores escaped pipes and filters open warnings', () => {
  const content = [
    '## Workflow Warnings',
    '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '| WW-1 | 2026-07-09 12:00:00+08:00 | issue-sync | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | task-comment | failed a\\|b | rerun a\\|b |  |  |',
    '| WW-2 | 2026-07-09 12:01:00+08:00 | issue-sync | IMPORTANT | METADATA_SYNC_SKIPPED | ignored | label | skipped | none | 2026-07-09 12:02:00+08:00 | not needed |'
  ].join('\n');

  const warnings = parseWorkflowWarnings(content);
  assert.equal(warnings[0]!.message, 'failed a|b');
  assert.equal(warnings[0]!.action, 'rerun a|b');
  assert.deepEqual(getOpenWorkflowWarnings(content).map((warning) => warning.id), ['WW-1']);
});

test('parseWorkflowWarnings restores escaped backslashes before pipes', () => {
  const content = String.raw`## Workflow Warnings

| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |
|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|
| WW-1 | 2026-07-09 12:00:00+08:00 | issue-sync | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | task-comment | failed a\\\|b | rerun a\\\|b |  |  |`;

  const [warning] = parseWorkflowWarnings(content);
  assert.equal(warning!.message, 'failed a\\|b');
  assert.equal(warning!.action, 'rerun a\\|b');
});

test('parseWorkflowWarnings accepts CRLF line endings', () => {
  const content = [
    '## Workflow Warnings',
    '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '| WW-1 | 2026-07-09 12:00:00+08:00 | create-task | IMPORTANT | PERMISSION_DEGRADED | open | label | skipped | wait for maintainer |  |  |'
  ].join('\r\n');

  assert.equal(parseWorkflowWarnings(content).length, 1);
});

test('formatWorkflowWarningSummary includes actionable fields', () => {
  const warnings = parseWorkflowWarnings([
    '## Workflow Warnings',
    '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '| WW-1 | 2026-07-09 12:00:00+08:00 | create-pr | ACTION_REQUIRED | PR_CREATE_FAILED | open | pr | failed | retry create-pr |  |  |'
  ].join('\n'));

  assert.deepEqual(formatWorkflowWarningSummary(warnings), [
    'WW-1 [ACTION_REQUIRED] PR_CREATE_FAILED pr - retry create-pr'
  ]);
});
