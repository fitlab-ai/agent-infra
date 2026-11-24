import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitHubClient } from '../../../../lib/platform/github-client.ts';
import { createTempDir, gitSafeEnv, initIsolatedGitRepo, onPlatforms } from '../../../helpers.ts';

test('stock gh version closes stdin while JSON request preserves exact bytes', onPlatforms('linux', 'darwin'), () => {
  const root = createTempDir('gh-r8-');
  const received = path.join(root, 'received');
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env node\nconst fs=require('fs');if(process.argv[2]==='--version'){if((process.env.TASK04_EXPECT_PIPE==='1')===fs.fstatSync(0).isCharacterDevice())process.exit(91);process.stdout.write('gh version 2.80.0\\n');}else{fs.writeFileSync(process.env.TASK04_GH_CAPTURE,fs.readFileSync(0));process.stdout.write('{"ok":true}');}\n`, {mode:0o755});
  const previous = { ...process.env };
  process.env.PATH = `${root}${path.delimiter}${previous.PATH}`;
  process.env.TASK04_GH_CAPTURE = received;
  delete process.env.AGENT_INFRA_GH_BIN;
  delete process.env.AGENT_INFRA_GH_ARGS_JSON;
  try {
    const client = createGitHubClient({ retryDelaysMs: [] });
    assert.deepEqual(client.version(), { ok: true, value: '2.80.0' });
    const body = '{"text":"é\\nvalue"}';
    assert.deepEqual(client.json(['api', 'local-only'], { method: 'POST', input: body }), { ok: true, value: {ok:true} });
    assert.deepEqual(fs.readFileSync(received), Buffer.from(body));
    process.env.AGENT_INFRA_GH_BIN = path.join(root, 'gh');
    process.env.TASK04_EXPECT_PIPE = '1';
    assert.deepEqual(client.version(), { ok: true, value: '2.80.0' });
  } finally {
    for (const key of ['PATH', 'TASK04_GH_CAPTURE', 'TASK04_EXPECT_PIPE', 'AGENT_INFRA_GH_BIN', 'AGENT_INFRA_GH_ARGS_JSON']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('short-id and large-file hook close stdin for fixed child commands', onPlatforms('linux', 'darwin'), () => {
  const root = createTempDir('fixed-scripts-r8-');
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, "if ((process.argv[1] || '').endsWith('internal-cli.ts') && !require('node:fs').fstatSync(0).isCharacterDevice()) process.exit(91);\n");
  const short = spawnSync(process.execPath, ['.agents/scripts/task-short-id.js', 'list', '--active-dir', root], { cwd: process.cwd(), encoding:'utf8', env:{...gitSafeEnv(), NODE_OPTIONS:`--require=${preload}`} });
  assert.equal(short.status, 0, short.stderr);
  assert.deepEqual(JSON.parse(short.stdout).ids, {});
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); initIsolatedGitRepo(repo);
  const realGit = spawnSync('which', ['git'], { encoding:'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(root,'git'), `#!/bin/sh\n[ -c /dev/stdin ] || exit 91\nexec "${realGit}" "$@"\n`, {mode:0o755});
  const hook = spawnSync(process.execPath, [path.resolve('.git-hooks/check-large-files.cjs')], { cwd:repo, encoding:'utf8', env:{...gitSafeEnv(), PATH:`${root}${path.delimiter}${process.env.PATH}`} });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stdout, /Large-file check passed/);
});

test('clipboard mount probe closes stdin before retaining PTY fallback', onPlatforms('linux', 'darwin'), async () => {
  const { runInteractiveWithClipboardBridge } = await import('../../../../lib/sandbox/clipboard/bridge.ts');
  const root = createTempDir('bridge-r8-');
  fs.writeFileSync(path.join(root, 'docker'), '#!/bin/sh\n[ -c /dev/stdin ]\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previous}`;
  let ptyLoads = 0;
  try {
    const status = await runInteractiveWithClipboardBridge({
      engine: 'native', dockerArgs: ['exec', '-it', 'fixture', 'sh'], container: 'fixture', home: root,
      stdin: { isTTY: true } as NodeJS.ReadStream, stdout: { isTTY: true } as NodeJS.WriteStream,
      adapter: { available: () => ({ ok: true }), readImagePng: () => null },
      loadPty: async () => { ptyLoads++; return null; }, runInteractive: () => 23, writeStderr: () => {}
    });
    assert.equal(status, 23);
    assert.equal(ptyLoads, 1);
  } finally { process.env.PATH = previous; }
});
