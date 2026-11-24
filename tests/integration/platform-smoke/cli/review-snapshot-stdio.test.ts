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

test('review snapshot forwards Git stderr on success and failure while retaining error bytes', onPlatforms('linux', 'darwin'), () => {
  const bin = createTempDir('review-stderr-shim-');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf marker-stderr >&2\nexit "${TASK04_GIT_EXIT:-0}"\n', { mode: 0o755 });
  const moduleUrl = new URL('../../../../lib/git/review-snapshot.ts', import.meta.url).href;
  const code = `import { snapshotReview } from ${JSON.stringify(moduleUrl)}; try { snapshotReview({cwd:process.cwd(),mode:'staged',baseline:'HEAD',globs:[]}); } catch (e) { process.stdout.write(JSON.stringify({status:e.status,stderr:String(e.stderr||''),code:e.code})); }`;
  const env = gitSafeEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const ok = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env });
  assert.match(ok.stderr, /marker-stderr/);
  const failed = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...env, TASK04_GIT_EXIT: '23' } });
  assert.match(failed.stderr, /marker-stderr/);
  const detail = JSON.parse(failed.stdout);
  assert.equal(detail.status, 23);
  assert.equal(detail.stderr, 'marker-stderr');
  const missing = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...env, PATH: createTempDir('missing-git-') } });
  assert.equal(JSON.parse(missing.stdout).code, 'ENOENT');
});
