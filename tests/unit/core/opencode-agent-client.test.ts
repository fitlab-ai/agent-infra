import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAgentClientAdapter } from '../../../lib/agent-clients/registry.ts';

function hookContext(home: string, toolDir: string, hostEnv: NodeJS.ProcessEnv = {}) {
  return {
    signal: AbortSignal.timeout(5_000),
    async runCommand() { return { stdout: '' }; },
    create: {
      hostHome: home,
      hostEnv,
      project: 'demo',
      resolvedTools: [{
        tool: getAgentClientAdapter('opencode').sandbox.createTool({ home, project: 'demo' }),
        dir: toolDir
      }]
    }
  };
}

test('OpenCode adapter declares its single-volume XDG, install, credential, and recovery contract', () => {
  const adapter = getAgentClientAdapter('opencode');
  const tool = adapter.sandbox.createTool({ home: '/host/home', project: 'demo' });

  assert.deepEqual(tool.install, { type: 'npm', cmd: 'opencode-ai' });
  assert.equal(tool.containerMount, '/home/devuser/.local/share/opencode');
  assert.deepEqual(tool.envVars, {
    XDG_DATA_HOME: '/home/devuser/.local/share',
    XDG_CONFIG_HOME: '/home/devuser/.local/share/opencode/.xdg/config',
    XDG_STATE_HOME: '/home/devuser/.local/share/opencode/.xdg/state'
  });
  assert.deepEqual(tool.hostLiveMounts, [{
    hostPath: '/host/home/.local/share/opencode/auth.json',
    containerSubpath: 'auth.json'
  }]);
  assert.deepEqual(
    adapter.sandbox.hooks.map(({ id, phase }) => ({ id, phase })),
    [{ id: 'opencode-before-container-create', phase: 'before-container-create' }]
  );
  assert.deepEqual(
    adapter.sandbox.recoveryChecks?.map(({ id }) => id),
    ['command-available', 'config-writable', 'state-writable']
  );
});

test('OpenCode hook uses host XDG config and fills only missing model strings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-adapter-'));
  const home = path.join(root, 'home');
  const toolDir = path.join(root, 'tool');
  const configHome = path.join(root, 'xdg-config');
  fs.mkdirSync(path.join(configHome, 'opencode'), { recursive: true });
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(
    path.join(configHome, 'opencode', 'opencode.json'),
    JSON.stringify({ model: 'provider/main', small_model: 'provider/small', token: 'secret' })
  );
  fs.writeFileSync(path.join(toolDir, 'opencode.json'), JSON.stringify({ model: 'legacy/main' }));

  const hook = getAgentClientAdapter('opencode').sandbox.hooks[0];
  assert.ok(hook);
  const result = await hook.run(hookContext(home, toolDir, { XDG_CONFIG_HOME: configHome }));

  assert.equal(result.status, 'ready');
  const canonical = path.join(toolDir, '.xdg', 'config', 'opencode', 'opencode.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(canonical, 'utf8')), {
    model: 'legacy/main',
    small_model: 'provider/small'
  });
  assert.ok(fs.existsSync(path.join(toolDir, 'opencode.json')));
});

test('OpenCode hook preserves canonical config and safely ignores invalid host inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-adapter-invalid-'));
  const home = path.join(root, 'home');
  const toolDir = path.join(root, 'tool');
  const canonical = path.join(toolDir, '.xdg', 'config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.writeFileSync(canonical, JSON.stringify({ model: 'sandbox/main' }));
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), '{ invalid');

  const hook = getAgentClientAdapter('opencode').sandbox.hooks[0];
  assert.ok(hook);
  await hook.run(hookContext(home, toolDir, { XDG_CONFIG_HOME: 'relative/path' }));

  assert.deepEqual(JSON.parse(fs.readFileSync(canonical, 'utf8')), { model: 'sandbox/main' });
  assert.ok(fs.statSync(path.join(toolDir, '.xdg', 'state', 'opencode')).isDirectory());
});
