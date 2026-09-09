import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyInProcess } from '../../../lib/task/verification-engine.ts';
import { parseImplementationInputs } from '../../../lib/task/implementation-inputs.ts';

const header = '## Implementation Inputs\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
for (const [label, time, evidence, expected] of [
  ['valid input', '2026-09-09 16:00:00+00:00', 'task.md#HDR-1', 'pass'],
  ['invalid time', 'invalid', 'task.md#HDR-1', 'fail'],
  ['escaped evidence', '2026-09-09 16:00:00+00:00', 'task.md#HDR-1|detail', 'pass'],
  ['missing decision time', '', 'task.md#HDR-1', 'fail']
] as const) {
  test(`implementation gate and parser agree on ${label}`, async () => {
    const table = header + `| II-1 | CD-1 | ${evidence.replaceAll('|', '\\|')} | code | true | ${time} | consumed | code-r2.md |\n`;
    if (expected === 'pass') assert.equal(parseImplementationInputs(table).rows[0]?.decisionEvidence, evidence);
    else assert.throws(() => parseImplementationInputs(table));
    assert.equal((await run(table, evidence, true)).status, expected);
  });
}

test('non-decision actions accept absent or empty input tables', async () => {
  for (const table of ['', header]) assert.equal((await run(table, '', false)).status, 'pass');
});

async function run(table: string, evidence: string, decision: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'implementation-contract-'));
  try {
    const configDir = path.join(root, '.agents/skills/probe/config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({ checks: { 'implementation-input': {} } }));
    fs.writeFileSync(path.join(root, 'task.md'), `---\nid: TASK-20260909-160000\n---\n${table}\n## Activity Log\n\n- 2026-09-09 16:01:00+00:00 — **Code Task (Round 2${decision ? ', decision II-1' : ''})** by codex — done\n`);
    fs.writeFileSync(path.join(root, 'code-r2.md'), `# Code\n\n## Implementation Input\n\n- **Decision Input**: \`${decision ? 'II-1' : 'N/A'}\`\n- **Ledger ID**: \`CD-1\`\n- **Decision Evidence**: \`${evidence}\`\n`);
    return await verifyInProcess({ mode: 'checks', skillName: 'probe', taskDir: root, artifactFile: 'code-r2.md', checks: ['implementation-input'], repositoryRoot: root });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
