import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { filePath, onPlatforms, writeNodeCommandShim } from '../../helpers.ts';

for (const scenario of ['first-install', 'upgrade', 'enable-failure', 'restart-failure'] as const) {
  test(`Linux installer applies the user service: ${scenario}`, onPlatforms('linux', 'darwin'), (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-service-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      installed: 1, loaded: 1, running: scenario === 'first-install' ? null : 1,
      enabled: false, restarts: 0
    }));
    // Replace only process boundaries; run the real POSIX installer with no host tools in PATH.
    const stub = path.join(root, 'command.cjs');
    fs.writeFileSync(stub, `
      const fs = require('node:fs');
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const [command, ...args] = process.argv.slice(2);
      const scenario = ${JSON.stringify(scenario)};
      if (command === 'uname') console.log('Linux');
      if (command === 'agent-infra-internal') state.installed = 2;
      if (command === 'systemctl') {
        const operation = args[1];
        if (operation === 'daemon-reload') state.loaded = state.installed;
        if (operation === 'enable') {
          if (scenario === 'enable-failure') process.exit(1);
          state.enabled = true;
          if (args.includes('--now') && state.running === null) state.running = state.loaded;
        }
        if (operation === 'restart') {
          state.restarts++;
          if (scenario !== 'restart-failure') state.running = state.loaded;
        }
        fs.writeFileSync(statePath, JSON.stringify(state));
        if (operation === 'restart' && scenario === 'restart-failure') process.exit(1);
      }
      fs.writeFileSync(statePath, JSON.stringify(state));
    `);
    for (const name of ['node', 'npm', 'uname', 'docker', 'agent-infra-internal', 'systemctl']) {
      const entry = path.join(root, `${name}.cjs`);
      fs.writeFileSync(entry, `process.argv.splice(2, 0, ${JSON.stringify(name)}); require(${JSON.stringify(stub)});`);
      writeNodeCommandShim(path.join(bin, name), entry);
    }
    const result = spawnSync('/bin/sh', [filePath('install.sh')], {
      cwd: root, env: { PATH: bin }, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.installed, 2);
    assert.equal(state.loaded, 2);
    assert.equal(state.enabled, scenario !== 'enable-failure');
    assert.equal(state.restarts, scenario === 'enable-failure' ? 0 : 1);
    assert.equal(state.running, scenario.endsWith('failure') ? 1 : 2);
    if (scenario.endsWith('failure')) {
      assert.ok(result.stdout.includes('systemctl --user restart agent-infra-host-control.service'));
    }
  });
}
