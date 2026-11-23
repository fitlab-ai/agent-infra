import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { onPlatforms } from '../../helpers.ts';

// The journal namespace is relative to HOME; isolate it in a subprocess.
test('sandbox removal journal validates before filtering and preserves decoded key order', onPlatforms('linux', 'darwin'), (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'removal-journal-test-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import fs from 'node:fs';
    import path from 'node:path';
    import { listSandboxRemovalJournals } from ${JSON.stringify(new URL('../../../lib/sandbox/control/lifecycle.ts', import.meta.url).href)};
    import { resolveSandboxLockNamespace } from ${JSON.stringify(new URL('../../../lib/sandbox/control/native-file-lock.ts', import.meta.url).href)};
    const ns = resolveSandboxLockNamespace('sandbox-removal-journal');
    const root = path.join(path.dirname(ns.lockRoot), 'sandbox-removal-journal', ns.lockDomain);
    fs.mkdirSync(root, { recursive: true });
    const digest = createHash('sha256').update('carrier').digest('hex');
    const file = path.join(root, digest + '.json');
    const record = {version:2, operation:'sandbox-rm', oldOperation:'sandbox-rm', newOperation:'sandbox-rm', handoffId:'handoff', transitionId:'transition', engine:'engine', containerId:'container', generation:'generation', carrierIdentityDigest:digest, lockDomain:ns.lockDomain, owner:{pid:1,startTime:1,leaseNonce:'nonce'}, phase:'prepared', expectedOldJournalRevision:null, revision:1, target:{branch:'branch',project:'project',controlRoot:'/control',targetDigest:'a'.repeat(64),permitDigest:'b'.repeat(64),removeWorktree:false,removeBranch:false,removeShare:false,worktreePaths:[],workspaceViewPaths:[],toolPaths:[],shellPaths:[],sharePath:'/share',permits:[]}, recordedAt:1};
    fs.writeFileSync(file, JSON.stringify({...record, authorityFingerprint:'obsolete'}));
    assert.equal(JSON.stringify(listSandboxRemovalJournals({branch:'branch'})[0]), JSON.stringify(record));
    assert.equal(listSandboxRemovalJournals({branch:'other'}).length, 0);
    assert.equal(listSandboxRemovalJournals({branch:''}).length, 1);
    fs.writeFileSync(file, JSON.stringify({...record, revision:2}));
    assert.throws(() => listSandboxRemovalJournals({branch:'other'}), /SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID/);
    for (const invalid of [
      '{',
      JSON.stringify({...record, unexpected:true}),
      JSON.stringify({...record, owner:{...record.owner, pid:0}}),
      JSON.stringify({...record, target:{...record.target, sharePath:'relative'}}),
      JSON.stringify({...record, target:{...record.target, permits:[{}]}}),
      JSON.stringify({...record, lockDomain:'c'.repeat(64)})
    ]) {
      fs.writeFileSync(file, invalid);
      assert.throws(() => listSandboxRemovalJournals({project:'other'}), /SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID/);
    }
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: homeDir }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
