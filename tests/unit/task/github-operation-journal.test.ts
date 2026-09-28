import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  GITHUB_OPERATION_JOURNAL_FILE,
  GITHUB_OPERATION_MAX_ATTEMPTS,
  readGithubOperationJournal,
  recordGithubOperation
} from '../../../lib/task/github-operation-journal.ts';

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'github-operation-journal-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  return { repoRoot, taskId, taskDir };
}

test('task-local GitHub operation journal deduplicates stable operations and stores only digests', () => {
  const f = fixture();
  try {
    const expectedDigest = createHash('sha256').update('projected artifact bytes').digest('hex');
    const input = {
      taskRef: f.taskId,
      cwd: f.repoRoot,
      kind: 'artifact-comment' as const,
      target: 'code.md',
      expectedDigest,
      dependency: 'required' as const,
      state: 'pending' as const
    };
    const first = recordGithubOperation(input);
    const second = recordGithubOperation({ ...input, state: 'unknown', lastCode: 'NETWORK_TIMEOUT' });
    const journal = readGithubOperationJournal(f.taskId, f.repoRoot);
    const serialized = fs.readFileSync(path.join(f.taskDir, GITHUB_OPERATION_JOURNAL_FILE), 'utf8');

    assert.equal(first.id, second.id);
    assert.equal(second.attempts, 1);
    assert.equal(journal.operations.length, 1);
    assert.equal(journal.operations[0]?.state, 'unknown');
    assert.equal(journal.operations[0]?.lastCode, 'NETWORK_TIMEOUT');
    assert.equal(journal.operations[0]?.maxAttempts, GITHUB_OPERATION_MAX_ATTEMPTS);
    assert.equal(serialized.includes('projected artifact bytes'), false);
    assert.equal(serialized.includes(expectedDigest), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});
