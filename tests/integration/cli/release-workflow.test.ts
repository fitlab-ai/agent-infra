import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { INTERNAL_CLI_PATH, gitSafeEnv, onPlatforms } from '../../helpers.ts';
import { computeDemoInputDigest } from '../../../lib/internal/release-workflow.ts';

type Fixture = { root: string; origin: string; preload: string; tools: string; environment: NodeJS.ProcessEnv };

function fixture(version = '0.8.6'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflow-cli-'));
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflow-origin-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflow-tools-'));
  const preload = path.join(root, 'fake-fetch.mjs');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['config', 'tag.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/widgets', version }));
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'widgets', org: 'acme', platform: { type: 'gitea' } }));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
  fs.writeFileSync(preload, 'globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return { root, origin, preload, tools, environment: {} };
}

function runCli(input: Fixture, ...args: string[]) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'release-workflow', ...args, '--cwd', input.root], {
    cwd: input.root,
    encoding: 'utf8',
    env: { ...gitSafeEnv(), ...input.environment, NODE_OPTIONS: `--import=${pathToFileURL(input.preload).href}` }
  });
}

function remoteSha(input: Fixture, ref: string): string | null {
  const output = spawnSync('git', ['ls-remote', '--exit-code', input.origin, ref], { encoding: 'utf8' });
  return output.status === 0 ? output.stdout.trim().split(/\s+/)[0] ?? null : null;
}

function cleanup(input: Fixture) {
  fs.rmSync(input.root, { recursive: true, force: true });
  fs.rmSync(input.origin, { recursive: true, force: true });
  fs.rmSync(input.tools, { recursive: true, force: true });
}

function enableGitHubChannels(input: Fixture, version: string, tagSha: string) {
  fs.writeFileSync(path.join(input.root, '.agents', '.airc.json'), JSON.stringify({ project: 'widgets', org: 'acme', platform: { type: 'github' } }));
  fs.writeFileSync(input.preload, `globalThis.fetch = async (url) => String(url).includes('registry.npmjs.org')
    ? ({ ok: true, status: 200, json: async () => ({ version: '${version}' }), text: async () => '' })
    : ({ ok: true, status: 200, json: async () => ({}), text: async () => 'url "https://registry.npmjs.org/@acme/widgets/-/widgets-${version}.tgz"\\nbottle do\\nend\\n' });\n`);
  const git = path.join(input.tools, 'git');
  fs.writeFileSync(git, '#!/bin/sh\nif [ "$1" = remote ] && [ "$2" = get-url ] && [ "$3" = origin ]; then printf "%s\\n" https://github.com/acme/widgets; exit 0; fi\nexec /usr/bin/git "$@"\n');
  fs.chmodSync(git, 0o755);
  const gh = path.join(input.tools, 'gh-fake.mjs');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('gh version 2.80.0');
else if (args[0] === 'api' && args[1] === 'user') console.log(JSON.stringify({ login: 'codex' }));
else if (args[0] === 'api') console.log(JSON.stringify({ full_name: 'acme/widgets', permissions: { triage: true, push: true, admin: true } }));
else if (args[0] === 'release') console.log(JSON.stringify({ tagName: 'v${version}', isDraft: false, url: 'https://example.test/release' }));
else if (args[0] === 'run') console.log(JSON.stringify([{ workflowName: 'Post-Release Smoke', event: 'workflow_run', headSha: '${tagSha}', status: 'completed', conclusion: 'success', createdAt: '2026-08-14T00:00:00Z', databaseId: 1, attempt: 1 }]));
else process.exitCode = 1;
`);
  fs.chmodSync(gh, 0o755);
  input.environment = {
    PATH: `${input.tools}:${process.env.PATH}`,
    AGENT_INFRA_GH_BIN: gh,
    AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: '0'
  };
}

function addPostPrepareInputs(input: Fixture) {
  const files = [
    'assets/demo-init.tape', 'scripts/demo-regen.sh', 'scripts/normalize-gif-duration.py',
    'bin/cli.ts', 'lib/init.ts', 'lib/log.ts', 'lib/prompt.ts', 'lib/paths.ts',
    'lib/render.ts', 'lib/builtin-tuis.ts', 'lib/sandbox/engines/index.ts',
    'src/sync-templates.js', 'templates/AGENTS.md', 'scripts/build-inline.js'
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(input.root, file)), { recursive: true });
    fs.writeFileSync(path.join(input.root, file), file === 'scripts/build-inline.js' ? '' : `${file}\n`);
  }
  fs.writeFileSync(path.join(input.root, 'package.json'), JSON.stringify({
    name: '@acme/widgets', version: '0.8.6', scripts: { build: 'node -e ""' }
  }));
  execFileSync('git', ['add', '.'], { cwd: input.root });
  fs.writeFileSync(path.join(input.root, 'assets', 'demo-init.inputs.sha256'), `${computeDemoInputDigest(input.root)}\n`);
  execFileSync('git', ['add', '.'], { cwd: input.root });
  execFileSync('git', ['commit', '-qm', 'release inputs'], { cwd: input.root });
}

test('release-workflow CLI rebuilds inspect phase from observable facts', () => {
  const input = fixture();
  try {
    const result = runCli(input, 'inspect', '0.8.6');
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.snapshot.phase, 'unprepared');
    assert.equal(payload.snapshot.facts.npm, false);
    assert.equal(payload.snapshot.facts.homebrew, false);
    assert.equal(payload.snapshot.facts.post.commit, null);
  } finally {
    cleanup(input);
  }
});

test('release publish requires an exact local tag and leaves the remote unchanged', () => {
  const input = fixture();
  try {
    execFileSync('git', ['tag', 'v0.8.6'], { cwd: input.root });
    fs.appendFileSync(path.join(input.root, 'tracked.txt'), 'later\n');
    execFileSync('git', ['commit', '-qam', 'fix: later change'], { cwd: input.root });

    const result = runCli(input, 'publish', '0.8.6');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'RELEASE_PHASE_INVALID');
    assert.equal(remoteSha(input, 'refs/heads/main'), null);
    assert.equal(remoteSha(input, 'refs/tags/v0.8.6'), null);
  } finally {
    cleanup(input);
  }
});

test('release prepare never publishes and partial publish can be replayed', () => {
  const input = fixture();
  try {
    execFileSync('git', ['tag', 'v0.8.6'], { cwd: input.root });
    const prepared = runCli(input, 'prepare', '0.8.6');
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(remoteSha(input, 'refs/heads/main'), null);
    assert.equal(remoteSha(input, 'refs/tags/v0.8.6'), null);

    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: input.root });
    const published = runCli(input, 'publish', '0.8.6');
    assert.equal(published.status, 0, published.stderr);
    assert.equal(remoteSha(input, 'refs/heads/main'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim());
    assert.equal(remoteSha(input, 'refs/tags/v0.8.6'), execFileSync('git', ['rev-parse', 'v0.8.6^{commit}'], { cwd: input.root, encoding: 'utf8' }).trim());
  } finally {
    cleanup(input);
  }
});

test('post inspect exposes confirmation only for a clean current post commit', () => {
  const input = fixture();
  try {
    execFileSync('git', ['tag', 'v0.8.6'], { cwd: input.root });
    execFileSync('git', ['push', '-q', 'origin', 'main', 'refs/tags/v0.8.6'], { cwd: input.root });
    fs.writeFileSync(path.join(input.root, 'package.json'), JSON.stringify({ name: '@acme/widgets', version: '0.8.7-alpha.0' }));
    execFileSync('git', ['commit', '-qam', 'chore: prepare next dev iteration after v0.8.6'], { cwd: input.root });

    const prepared = JSON.parse(runCli(input, 'inspect', '0.8.6').stdout).snapshot;
    assert.equal(prepared.phase, 'post-prepared');
    assert.equal(prepared.facts.post.isHead, true);
    assert.match(prepared.postConfirmation.sha256, /^sha256:[0-9a-f]{64}$/);

    fs.appendFileSync(path.join(input.root, 'tracked.txt'), 'dirty\n');
    const dirty = JSON.parse(runCli(input, 'inspect', '0.8.6').stdout).snapshot;
    assert.equal(dirty.phase, 'post-prepared');
    assert.equal(Object.hasOwn(dirty, 'postConfirmation'), false);
    fs.writeFileSync(path.join(input.root, 'tracked.txt'), 'initial\n');

    fs.appendFileSync(path.join(input.root, 'tracked.txt'), 'later\n');
    execFileSync('git', ['commit', '-qam', 'fix: later change'], { cwd: input.root });
    const drifted = JSON.parse(runCli(input, 'inspect', '0.8.6').stdout).snapshot;
    assert.equal(drifted.facts.post.isHead, false);
    assert.equal(Object.hasOwn(drifted, 'postConfirmation'), false);
  } finally {
    cleanup(input);
  }
});

test('post publish rejects a stale confirmation without changing the remote', () => {
  const input = fixture();
  try {
    execFileSync('git', ['tag', 'v0.8.6'], { cwd: input.root });
    execFileSync('git', ['push', '-q', 'origin', 'main', 'refs/tags/v0.8.6'], { cwd: input.root });
    const baseline = remoteSha(input, 'refs/heads/main');
    fs.writeFileSync(path.join(input.root, 'package.json'), JSON.stringify({ name: '@acme/widgets', version: '0.8.7-alpha.0' }));
    execFileSync('git', ['commit', '-qam', 'chore: prepare next dev iteration after v0.8.6'], { cwd: input.root });

    const result = runCli(input, 'post-publish', '0.8.6', '--expected-sha256', `sha256:${'0'.repeat(64)}`);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'RELEASE_POST_SNAPSHOT_MISMATCH');
    assert.equal(remoteSha(input, 'refs/heads/main'), baseline);
  } finally {
    cleanup(input);
  }
});

test('post prepare creates a confirmable commit without changing the remote', onPlatforms('linux', 'darwin'), () => {
  const input = fixture();
  try {
    addPostPrepareInputs(input);
    let tagSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim();
    enableGitHubChannels(input, '0.8.6', tagSha);
    execFileSync('git', ['add', '.'], { cwd: input.root });
    execFileSync('git', ['commit', '--amend', '--no-edit', '-q'], { cwd: input.root });
    tagSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim();
    enableGitHubChannels(input, '0.8.6', tagSha);
    execFileSync('git', ['tag', 'v0.8.6'], { cwd: input.root });
    execFileSync('git', ['push', '-q', 'origin', 'main', 'refs/tags/v0.8.6'], { cwd: input.root });
    const baseline = remoteSha(input, 'refs/heads/main');

    const prepared = runCli(input, 'post-prepare', '0.8.6');
    assert.equal(prepared.status, 0, prepared.stderr);
    const snapshot = JSON.parse(prepared.stdout).snapshot;
    assert.equal(snapshot.phase, 'post-prepared');
    assert.match(snapshot.postConfirmation.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(remoteSha(input, 'refs/heads/main'), baseline);
  } finally {
    cleanup(input);
  }
});

test('post publish performs one normal push and complete replay is a no-op', onPlatforms('linux', 'darwin'), () => {
  const input = fixture();
  try {
    fs.appendFileSync(path.join(input.root, 'tracked.txt'), 'release\n');
    execFileSync('git', ['commit', '-qam', 'release'], { cwd: input.root });
    const tagSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim();
    enableGitHubChannels(input, '0.8.6', tagSha);
    execFileSync('git', ['add', '.'], { cwd: input.root });
    execFileSync('git', ['commit', '--amend', '--no-edit', '-q'], { cwd: input.root });
    const amendedTagSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim();
    enableGitHubChannels(input, '0.8.6', amendedTagSha);
    execFileSync('git', ['tag', 'v0.8.6'], { cwd: input.root });
    execFileSync('git', ['push', '-q', 'origin', 'main', 'refs/tags/v0.8.6'], { cwd: input.root });
    fs.writeFileSync(path.join(input.root, 'package.json'), JSON.stringify({ name: '@acme/widgets', version: '0.8.7-alpha.0' }));
    execFileSync('git', ['commit', '-qam', 'chore: prepare next dev iteration after v0.8.6'], { cwd: input.root });

    const prepared = JSON.parse(runCli(input, 'inspect', '0.8.6').stdout).snapshot;
    assert.equal(prepared.phase, 'post-prepared');
    const published = runCli(input, 'post-publish', '0.8.6', '--expected-sha256', prepared.postConfirmation.sha256);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).snapshot.phase, 'complete');
    assert.equal(remoteSha(input, 'refs/heads/main'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim());

    const replayed = runCli(input, 'post-publish', '0.8.6', '--expected-sha256', prepared.postConfirmation.sha256);
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
  } finally {
    cleanup(input);
  }
});

test('legacy post action fails closed without changing the remote', () => {
  const input = fixture();
  try {
    const result = runCli(input, 'post', '0.8.6');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'RELEASE_INPUT_INVALID');
    assert.equal(remoteSha(input, 'refs/heads/main'), null);
  } finally {
    cleanup(input);
  }
});
