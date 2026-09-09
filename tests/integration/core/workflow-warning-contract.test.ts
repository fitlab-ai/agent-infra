import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';
import { applyWorkflowWarningIntent } from '../../../lib/task/workflow-warning-intents.ts';
import { parseWorkflowWarnings, WORKFLOW_WARNING_COLUMNS } from '../../../lib/task/workflow-warnings.ts';
import { VERSION } from '../../../lib/version.ts';

const row = ['WW-1', '2026-09-09 16:00:00', 'probe', 'IMPORTANT', 'PROBE', 'open', 'task', 'message', 'retry', '', ''];
const tableRow = (cells: readonly string[]) => '| ' + cells.join(' | ') + ' |';
const table = (rows: readonly string[][], heading = 'Workflow Warnings') =>
  `## ${heading}\n\n${tableRow(WORKFLOW_WARNING_COLUMNS)}\n${tableRow(WORKFLOW_WARNING_COLUMNS.map(() => '---'))}\n${rows.map(tableRow).join('\n')}\n`;

for (const [name, body, code] of [
  ['zero ID', table([['WW-0', ...row.slice(1)]]), 'WARNING_ID_INVALID'],
  ['duplicate ID', table([row, row]), 'TABLE_DUPLICATE_KEY'],
  ['extra column', table([[...row, 'unexpected']]), 'TASK_DOCUMENT_INVALID'],
  ['missing column', table([row.slice(0, -1)]), 'TASK_DOCUMENT_INVALID'],
  ['invalid time', table([row.map((value, i) => i === 1 ? 'invalid' : value)]), 'WARNING_DOCUMENT_INVALID'],
  ['missing action', table([row.map((value, i) => i === 8 ? '' : value)]), 'WARNING_DOCUMENT_INVALID'],
  ['incomplete resolution', table([row.map((value, i) => i === 5 ? 'resolved' : value)]), 'WARNING_DOCUMENT_INVALID'],
  ['ambiguous sections', table([row]) + table([row], '工作流告警'), 'TASK_DOCUMENT_INVALID']
] as const) {
  test(`warning readers and verification reject ${name}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-contract-'));
    const taskId = 'TASK-20260909-160000';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    const configDir = path.join(root, '.agents', 'skills', 'probe', 'config');
    try {
      fs.mkdirSync(taskDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({ checks: { 'task-meta': { required_fields: ['id'] } } }));
      const prefix = `---\nid: ${taskId}\nstatus: active\nagent_infra_version: ${VERSION}\n---\n\n`;
      const taskPath = path.join(taskDir, 'task.md');
      fs.writeFileSync(taskPath, prefix + table([row]));
      const verify = () => verifyInProcess({ mode: 'checks', skillName: 'probe', taskDir, checks: ['task-meta'], repositoryRoot: root });
      assert.equal((await verify()).status, 'pass');
      assert.equal(applyWorkflowWarningIntent({ kind: 'list', taskRef: taskId }, { repoRoot: root }).status, 'no-op');

      const content = prefix + body;
      fs.writeFileSync(taskPath, content);
      assert.equal((await verify()).status, 'fail');
      const listed = applyWorkflowWarningIntent({ kind: 'list', taskRef: taskId }, { repoRoot: root });
      assert.equal(listed.status, 'failed');
      assert.equal(listed.error?.code, code);
      const added = applyWorkflowWarningIntent({
        kind: 'add', taskRef: taskId, step: 'probe', severity: 'IMPORTANT',
        code: 'NEXT', target: 'task', message: 'next warning', action: 'retry'
      }, { repoRoot: root });
      assert.equal(added.status, 'failed');
      assert.equal(added.error?.code, code);
      assert.throws(() => parseWorkflowWarnings(content), { code });
      assert.equal(fs.readFileSync(taskPath, 'utf8'), content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('warning parser preserves absent and empty tables and escaped cell values', () => {
  assert.deepEqual(parseWorkflowWarnings('# Task\n'), []);
  for (const heading of ['工作流告警', 'Workflow Warnings']) {
    assert.deepEqual(parseWorkflowWarnings(table([], heading)), []);
    const escaped = row.map((value, i) => i === 7 ? String.raw`path\\part\|detail` : value);
    assert.equal(parseWorkflowWarnings(table([escaped], heading).replaceAll('\n', '\r\n'))[0]?.message, 'path\\part|detail');
  }
});
