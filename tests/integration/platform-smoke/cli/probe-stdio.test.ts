import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectWorktree } from '../../../../lib/sandbox/worktree-safety.ts';
import { discoverExactContainer } from '../../../../lib/sandbox/engines/docker-exact-discovery.ts';
import { createTempDir, gitSafeEnv, initIsolatedGitRepo, onPlatforms, withGitSafeProcessEnv } from '../../../helpers.ts';

test('real worktree and docker probes run without an unused stdin pipe', onPlatforms('linux', 'darwin'), () => {
  const root = createTempDir('worktree-probe-');
  initIsolatedGitRepo(root);
  const env = gitSafeEnv({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  const commit = spawnSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: root, encoding: 'utf8', env });
  assert.equal(commit.status, 0, commit.stderr);
  const bin = createTempDir('probe-shim-');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n[ -c /dev/stdin ] || exit 91\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n[ -c /dev/stdin ] || exit 91\n', { mode: 0o755 });
  withGitSafeProcessEnv(() => {
    assert.equal(inspectWorktree(root).status, 'clean');
    assert.equal(discoverExactContainer('native', 'a'.repeat(64)).state, 'absent');
  }, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
});
