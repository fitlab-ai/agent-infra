import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { INTERNAL_CLI_PATH, gitSafeEnv, onPlatforms } from '../../helpers.ts';
import { collectDemoTranscript, DEMO_PROJECT_PATH, sha256Transcript } from '../../../lib/internal/demo-transcript.ts';

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
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'widgets', org: 'acme', platform: { type: 'none' } }));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
  fs.writeFileSync(preload, 'globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });\n');
  const fakeZsh = path.join(tools, 'zsh');
  fs.writeFileSync(fakeZsh, `#!/bin/sh
stty -echo 2>/dev/null || true
printf '%s' "\${PROMPT:-\${HOSTNAME}%# }"
printf '%s\\n' 'Project name' 'Organization' 'Language' 'Sandbox engine' 'Platform' 'Agent Client project integrations' 'Template sources' 'Skill sources' 'initialized'
printf '\\033]9;agent-infra-demo-checkpoint\\007'
printf '\\033]9;agent-infra-demo-tree-checkpoint\\007'
printf '%s\\n' '.agents'
while IFS= read -r line; do
  [ "$line" = "exit" ] && break
done
exit 0
`);
  fs.chmodSync(fakeZsh, 0o755);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return { root, origin, preload, tools, environment: { PATH: `${tools}${path.delimiter}${process.env.PATH ?? ''}` } };
}

test('demo collector fixes the shell prompt across hostnames', onPlatforms('linux', 'darwin'), async () => {
  const input = fixture();
  const previousPath = process.env.PATH;
  const previousHostname = process.env.HOSTNAME;
  try {
    fs.mkdirSync(path.join(input.root, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(input.root, 'dist', 'bin', 'cli.js'), '');
    process.env.PATH = input.environment.PATH;
    process.env.HOSTNAME = 'release-host-one';
    const first = await collectDemoTranscript(input.root);
    process.env.HOSTNAME = 'release-host-two';
    const second = await collectDemoTranscript(input.root);
    assert.equal(first.status, 'ok', first.status === 'failed' ? first.message : '');
    assert.equal(second.status, 'ok', second.status === 'failed' ? second.message : '');
    if (first.status !== 'ok' || second.status !== 'ok') return;
    assert.equal(second.sha256, first.sha256);
    assert.match(first.transcript, /demo\$ /);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = previousHostname;
    cleanup(input);
  }
});

test('demo collector preserves an existing canonical project directory', onPlatforms('linux', 'darwin'), async () => {
  const input = fixture();
  const canonicalExisted = fs.existsSync(DEMO_PROJECT_PATH);
  const sentinel = path.join(DEMO_PROJECT_PATH, `.demo-collector-sentinel-${process.pid}-${Date.now()}`);
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(DEMO_PROJECT_PATH, { recursive: true });
    fs.writeFileSync(sentinel, 'preserve');
    fs.mkdirSync(path.join(input.root, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(input.root, 'dist', 'bin', 'cli.js'), '');
    process.env.PATH = input.environment.PATH;
    const collected = await collectDemoTranscript(input.root);
    assert.equal(collected.status, 'ok', collected.status === 'failed' ? collected.message : '');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(sentinel, { force: true });
    if (!canonicalExisted && fs.existsSync(DEMO_PROJECT_PATH) && fs.readdirSync(DEMO_PROJECT_PATH).length === 0) fs.rmdirSync(DEMO_PROJECT_PATH);
    cleanup(input);
  }
});

test('demo collector handles a temporary root with spaces and shell metacharacters', onPlatforms('linux', 'darwin'), async () => {
  const input = fixture();
  const previousPath = process.env.PATH;
  const previousTmpdir = process.env.TMPDIR;
  const tmpRoot = path.join(os.tmpdir(), `demo collector tmp ${process.pid}-${Date.now()};safe`);
  const sentinel = path.join(tmpRoot, 'outside-project.txt');
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(sentinel, 'preserve');
    fs.mkdirSync(path.join(input.root, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(input.root, 'dist', 'bin', 'cli.js'), '');
    process.env.PATH = input.environment.PATH;
    process.env.TMPDIR = tmpRoot;
    const collected = await collectDemoTranscript(input.root);
    assert.equal(collected.status, 'ok', collected.status === 'failed' ? collected.message : '');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    cleanup(input);
  }
});

test('demo collector does not evaluate shell syntax in the local CLI path', onPlatforms('linux', 'darwin'), async () => {
  const input = fixture();
  const markerName = `demo-transcript-shell-${process.pid}-${Date.now()}`;
  const marker = path.join(os.tmpdir(), markerName);
  const unsafeRoot = path.join(os.tmpdir(), `demo$(touch ${markerName})`);
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(unsafeRoot, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(unsafeRoot, 'dist', 'bin', 'cli.js'), '');
    fs.writeFileSync(path.join(input.tools, 'zsh'), [
      '#!/bin/sh',
      "printf '%s' 'demo$ '",
      'ai >/dev/null 2>&1 || true',
      "printf '%s\\n' 'Project name' 'Organization' 'Language' 'Sandbox engine' 'Platform' 'Agent Client project integrations' 'Template sources' 'Skill sources' 'initialized'",
      "printf '\\033]9;agent-infra-demo-checkpoint\\007'",
      "printf '\\033]9;agent-infra-demo-tree-checkpoint\\007'",
      "printf '%s\\n' '.agents'",
      'while IFS= read -r line; do',
      '  [ "$line" = "exit" ] && break',
      'done',
      'exit 0',
      ''
    ].join('\n'));
    fs.chmodSync(path.join(input.tools, 'zsh'), 0o755);
    process.env.PATH = input.environment.PATH;
    const collected = await collectDemoTranscript(unsafeRoot);
    assert.equal(collected.status, 'ok', collected.status === 'failed' ? collected.message : '');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(marker, { force: true });
    fs.rmSync(unsafeRoot, { recursive: true, force: true });
    cleanup(input);
  }
});

function runCli(input: Fixture, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...gitSafeEnv(), ...input.environment, NODE_OPTIONS: `--import=${pathToFileURL(input.preload).href}` };
  for (const key of [
    'AGENT_INFRA_TASK_ID', 'AGENT_INFRA_CONTROL_TOKEN', 'AGENT_INFRA_CONTROL_GENERATION',
    'AGENT_INFRA_CONTROL_DIR', 'AGENT_INFRA_CONTROL_STATUS_DIR', 'AGENT_INFRA_RUNTIME_DIR',
    'AGENT_INFRA_EXECUTOR_MANIFEST', 'AGENT_INFRA_CONTROL_CONTROLLER_BINDING'
  ]) delete env[key];
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'release-workflow', ...args, '--cwd', input.root], {
    cwd: input.root,
    encoding: 'utf8',
    env
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
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({ data: { viewer: { login: 'codex' } } }));
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

async function addPostPrepareInputs(input: Fixture) {
  const files = [
    'assets/demo-init.tape', 'scripts/demo-regen.sh', 'scripts/normalize-gif-duration.py',
    'bin/cli.ts', 'lib/init.ts', 'lib/log.ts', 'lib/prompt.ts', 'lib/paths.ts',
    'lib/render.ts', 'lib/sandbox/engines/index.ts',
    'src/sync-templates.js', 'templates/AGENTS.md', 'scripts/build-inline.js'
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(input.root, file)), { recursive: true });
    fs.writeFileSync(path.join(input.root, file), file === 'scripts/build-inline.js' ? '' : `${file}\n`);
  }
  fs.writeFileSync(path.join(input.root, 'package.json'), JSON.stringify({
    name: '@acme/widgets', version: '0.8.6', scripts: {
      build: 'node -e "require(\'fs\').mkdirSync(\'dist/bin\',{recursive:true});require(\'fs\').writeFileSync(\'dist/bin/cli.js\',\'\')"'
    }
  }));
  fs.mkdirSync(path.join(input.root, 'dist', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(input.root, 'dist', 'bin', 'cli.js'), '');
  fs.writeFileSync(path.join(input.root, '.gitignore'), 'dist/\n');
  const previousPath = process.env.PATH;
  process.env.PATH = input.environment.PATH;
  const collected = await collectDemoTranscript(input.root);
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (collected.status === 'failed') throw new Error(collected.message);
  process.env.PATH = input.environment.PATH;
  const repeated = await collectDemoTranscript(input.root);
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (repeated.status === 'failed') throw new Error(repeated.message);
  assert.equal(repeated.sha256, collected.sha256, `${JSON.stringify(collected.transcript)} != ${JSON.stringify(repeated.transcript)}`);
  const transcript = collected.transcript;
  fs.writeFileSync(path.join(input.root, 'assets', 'demo-init.transcript'), transcript);
  fs.writeFileSync(path.join(input.root, 'assets', 'demo-init.transcript.sha256'), `${sha256Transcript(transcript)}\n`);
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

test('post prepare creates a confirmable commit without changing the remote', onPlatforms('linux', 'darwin'), async () => {
  const input = fixture();
  try {
    await addPostPrepareInputs(input);
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
    assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);
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
    assert.ok(result.stdout, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, 'RELEASE_INPUT_INVALID', `${result.stderr}\n${result.stdout}`);
    assert.equal(remoteSha(input, 'refs/heads/main'), null);
  } finally {
    cleanup(input);
  }
});
