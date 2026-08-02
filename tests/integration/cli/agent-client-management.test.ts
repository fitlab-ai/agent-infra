import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cliArgs } from '../../helpers.ts';
import { AGENT_CLIENT_IDS } from '../../../lib/agent-clients/types.ts';

function canonical(enabled: readonly string[], installed: readonly string[]) {
  return AGENT_CLIENT_IDS.map((id) => ({
    id,
    enabled: enabled.includes(id),
    installInSandbox: installed.includes(id)
  }));
}

function writeConfig(root: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents/.airc.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
}

test('agent-client list is registry-backed and does not require a project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-list-'));
  try {
    const output = execFileSync(process.execPath, cliArgs('agent-client', 'list'), {
      cwd: root,
      encoding: 'utf8'
    });
    for (const id of AGENT_CLIENT_IDS) assert.match(output, new RegExp(id));
    assert.equal(fs.existsSync(path.join(root, '.agents')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('enable migrates legacy state first and changes only enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-enable-'));
  try {
    writeConfig(root, {
      project: 'demo',
      org: 'acme',
      language: 'en',
      platform: { type: 'github' },
      tuis: ['codex'],
      sandbox: { tools: ['agent-infra', 'claude-code'], customTools: [{ id: 'custom' }] },
      files: { managed: [], merged: [], ejected: [] }
    });

    execFileSync(process.execPath, cliArgs('agent-client', 'enable', 'opencode'), {
      cwd: root,
      encoding: 'utf8'
    });
    const config = JSON.parse(fs.readFileSync(path.join(root, '.agents/.airc.json'), 'utf8'));

    assert.deepEqual(config.agentClients, canonical(['codex', 'opencode'], ['claude-code']));
    assert.equal('tuis' in config, false);
    assert.deepEqual(config.sandbox.tools, ['agent-infra']);
    assert.deepEqual(config.sandbox.customTools, [{ id: 'custom' }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disable preserves installInSandbox and unknown ids fail without writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-disable-'));
  try {
    const initial = {
      project: 'demo',
      org: 'acme',
      language: 'en',
      platform: { type: 'github' },
      agentClients: canonical(['codex', 'opencode'], ['codex', 'opencode']),
      sandbox: { tools: ['agent-infra'] },
      files: { managed: [], merged: [], ejected: [] }
    };
    writeConfig(root, initial);

    execFileSync(process.execPath, cliArgs('agent-client', 'disable', 'codex'), {
      cwd: root,
      encoding: 'utf8'
    });
    const afterDisable = JSON.parse(fs.readFileSync(path.join(root, '.agents/.airc.json'), 'utf8'));
    const codex = afterDisable.agentClients.find((entry: { id: string }) => entry.id === 'codex');
    assert.deepEqual(codex, { id: 'codex', enabled: false, installInSandbox: true });

    const beforeUnknown = fs.readFileSync(path.join(root, '.agents/.airc.json'), 'utf8');
    const result = spawnSync(process.execPath, cliArgs('agent-client', 'enable', 'unknown'), {
      cwd: root,
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UNKNOWN_AGENT_CLIENT/);
    assert.equal(fs.readFileSync(path.join(root, '.agents/.airc.json'), 'utf8'), beforeUnknown);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status is read-only and configure edits both independent dimensions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-configure-'));
  try {
    writeConfig(root, {
      project: 'demo',
      org: 'acme',
      language: 'en',
      platform: { type: 'github' },
      agentClients: canonical(['codex'], ['claude-code']),
      sandbox: { tools: ['agent-infra'] },
      files: { managed: [], merged: [], ejected: [] }
    });
    const configPath = path.join(root, '.agents/.airc.json');
    const beforeStatus = fs.readFileSync(configPath, 'utf8');
    const status = execFileSync(process.execPath, cliArgs('agent-client', 'status'), {
      cwd: root,
      encoding: 'utf8'
    });
    assert.match(status, /source: canonical/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeStatus);

    execFileSync(process.execPath, cliArgs('agent-client', 'configure'), {
      cwd: root,
      input: '1,4\n2,3\n',
      encoding: 'utf8'
    });
    const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(
      configured.agentClients,
      canonical(['claude-code', 'opencode'], ['codex', 'gemini-cli'])
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
