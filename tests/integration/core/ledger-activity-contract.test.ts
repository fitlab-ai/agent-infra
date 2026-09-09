import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';
import { parseLedgerDocument, validateLedgerRows } from '../../../lib/task/ledger.ts';
import { locateActivityLog } from '../../../lib/task/activity-log.ts';

async function verify(content: string, check: string, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-activity-contract-'));
  try {
    const configDir = path.join(root, '.agents/skills/probe/config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'task.md'), `---\nid: TASK-20260909-160000\n---\n${content}`);
    fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({ checks: { [check]: config } }));
    return await verifyInProcess({ mode: 'checks', skillName: 'probe', taskDir: root, checks: [check], repositoryRoot: root });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const ledger = (rows: string[]) => '## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n| --- | --- | --- | --- | --- | --- |\n' + rows.join('\n');
for (const row of [
  '| INVALID | code | 1 | major | closed | code.md#finding |',
  '| CD-1 | code | bad | major | closed | code.md#finding |',
  '| CD-1 | code | 1 | nonsense | closed | code.md#finding |',
  '| AN-1 | code | 1 | major | closed | code.md#finding |'
]) {
  test(`ledger gate shares row validation: ${row}`, async () => {
    const content = ledger([row]);
    assert.ok(validateLedgerRows(parseLedgerDocument(content).rows));
    assert.equal((await verify(content, 'review-ledger')).status, 'fail');
  });
}

test('ledger gate preserves stage scope and separate post-review exemption policy', async () => {
  const content = ledger([
    '| AN-1 | analysis | 1 | minor | closed | analysis.md#finding |',
    '| INVALID | code | bad | nonsense | closed | code.md#finding |',
    '| PRC-1 | post-review-commit | - | - | open | pending |'
  ]);
  assert.equal((await verify(content, 'review-ledger', { stage_scope: ['analysis'] })).status, 'pass');
  assert.equal((await verify(content, 'review-ledger')).status, 'fail');
});

const entry = (time: string, step = 'Code Task (Round 1)') => `- ${time} — **${step}** by codex — done`;
test('activity gate rejects timestamps not recognized by the shared reader', async () => {
  for (const time of ['2026-09-09T16:00:00', '2026-09-09 16:00:00']) {
    const content = `## Activity Log\n\n${entry(time)}\n`;
    assert.equal(locateActivityLog(content)?.entries.length, 0);
    assert.equal((await verify(content, 'activity-log')).status, 'fail');
  }
});

test('activity reader and gate use only one visible section and ignore fenced examples', async () => {
  const real = entry('2026-09-09 16:00:00+00:00');
  const content = ['```md', '## Activity Log', real, '```', '## 活动日志', '', '~~~', real, '~~~', real, ''].join('\r\n');
  assert.equal(locateActivityLog(content)?.entries.length, 1);
  assert.equal((await verify(content, 'activity-log')).status, 'pass');
  const ambiguous = `## Activity Log\n${real}\n## 活动日志\n${real}\n`;
  assert.equal(locateActivityLog(ambiguous), null);
  assert.equal((await verify(ambiguous, 'activity-log')).status, 'fail');
});

test('activity gate checks source order while the reader sorts and skips malformed lines', async () => {
  const content = `## Activity Log\n${entry('2026-09-09 17:00:00+00:00', 'Later')}\n${entry('2026-09-09 16:00:00+00:00', 'Earlier')}\n`;
  assert.deepEqual(locateActivityLog(content)?.entries.map((item) => item.step), ['Earlier', 'Later']);
  assert.equal((await verify(content, 'activity-log')).status, 'fail');
  const malformed = `## Activity Log\n${entry('2026-09-09 16:00:00+00:00')}\n- malformed\n`;
  assert.equal(locateActivityLog(malformed)?.entries.length, 1);
  assert.equal((await verify(malformed, 'activity-log')).status, 'fail');
});

test('activity gate rejects empty notes while the reader retains the entry', async () => {
  for (const note of ['', '   ']) {
    const content = `## Activity Log\n- 2026-09-09 16:00:00+00:00 — **Code Task (Round 1)** by codex — ${note}\n`;
    assert.equal(locateActivityLog(content)?.entries.length, 1);
    assert.equal((await verify(content, 'activity-log')).status, 'fail');
  }
});

test('activity gate retains done-action selection across starts and trailing commits', async () => {
  const content = ['## Activity Log', entry('2026-09-09 16:00:00+00:00'), entry('2026-09-09 16:01:00+00:00', 'Commit'), entry('2026-09-09 16:02:00+00:00', 'Review Code (Round 1) [started]')].join('\n');
  assert.equal((await verify(content, 'activity-log', { expected_action_pattern: '^Code Task' })).status, 'pass');
});
