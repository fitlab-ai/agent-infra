import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { INTERNAL_CLI_PATH, gitSafeEnv } from '../../helpers.ts';

test('release-workflow CLI rebuilds inspect phase from observable facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflow-cli-'));
  const preload = path.join(root, 'fake-fetch.mjs');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    execFileSync('git', ['config', 'tag.gpgsign', 'false'], { cwd: root });
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/widgets', version: '0.8.6-alpha.0' }));
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'widgets', org: 'acme', platform: { type: 'gitea' } }));
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    fs.writeFileSync(preload, 'globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });\n');
    const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'release-workflow', 'inspect', '0.8.6'], {
      cwd: root, encoding: 'utf8', env: { ...gitSafeEnv(), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.snapshot.phase, 'unprepared');
    assert.equal(payload.snapshot.facts.npm, false);
    assert.equal(payload.snapshot.facts.homebrew, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-workflow CLI keeps a completed post fact after later commits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflow-history-'));
  const preload = path.join(root, 'fake-fetch.mjs');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    execFileSync('git', ['config', 'tag.gpgsign', 'false'], { cwd: root });
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/widgets', version: '0.8.6-alpha.0' }));
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'widgets', org: 'acme', platform: { type: 'gitea' } }));
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'release\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'release'], { cwd: root });
    execFileSync('git', ['tag', 'v0.8.6'], { cwd: root });
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'post\n');
    execFileSync('git', ['commit', '-qam', 'chore: prepare next dev iteration after v0.8.6'], { cwd: root });
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'later\n');
    execFileSync('git', ['commit', '-qam', 'fix: later change'], { cwd: root });
    fs.writeFileSync(preload, 'globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });\n');
    const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'release-workflow', 'inspect', '0.8.6'], {
      cwd: root, encoding: 'utf8', env: { ...gitSafeEnv(), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }
    });
    assert.equal(result.status, 0, result.stderr);
    const facts = JSON.parse(result.stdout).snapshot.facts;
    assert.equal(facts.localTag, false);
    assert.equal(facts.localTagAncestor, true);
    assert.equal(facts.localTagConflict, false);
    assert.equal(facts.postCommit, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
