import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshotReview } from '../../../../lib/git/review-snapshot.ts';
import { createTempDir, gitSafeEnv, initIsolatedGitRepo, onPlatforms, withGitSafeProcessEnv } from '../../../helpers.ts';

test('review snapshot reserves a pipe for index data and closes it for Git queries', onPlatforms('linux', 'darwin'), () => {
  const root = createTempDir('review-snapshot-stdio-');
  initIsolatedGitRepo(root);
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitSafeEnv({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  fs.writeFileSync(path.join(root, 'file.txt'), 'before\n');
  git(['add', 'file.txt']);
  git(['commit', '-qm', 'base']);
  const baseline = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'file.txt'), 'after\n');
  git(['add', 'file.txt']);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(root, 'test-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --index-info "*) [ ! -c /dev/stdin ] || exit 92 ;; *) [ -c /dev/stdin ] || exit 91 ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const staged = withGitSafeProcessEnv(() => snapshotReview({ cwd: root, mode: 'staged', baseline, globs: ['file.txt'] }), { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(staged.tree, git(['write-tree']));
});
