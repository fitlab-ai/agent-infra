import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyAgentClientReconciliation,
  planAgentClientReconciliation
} from '../../../lib/agent-clients/reconcile.ts';
import { AGENT_CLIENT_IDS } from '../../../lib/agent-clients/types.ts';

function writeTemplates(root: string): void {
  const files = [
    ['.claude/commands/update-agent-infra.en.md', 'claude {{project}}'],
    ['.claude/commands/update-agent-infra.zh-CN.md', 'claude zh {{project}}'],
    ['docs/templates/update-agent-infra.en.md', 'docs {{project}}'],
    ['docs/templates/update-agent-infra.zh-CN.md', 'docs zh {{project}}'],
    ['.opencode/commands/update-agent-infra.en.md', 'opencode {{project}}'],
    ['.opencode/commands/update-agent-infra.zh-CN.md', 'opencode zh {{project}}'],
    ['.trae/skills/update-agent-infra.en.md', 'traecli {{project}}'],
    ['.trae/skills/update-agent-infra.zh-CN.md', 'traecli zh {{project}}']
  ];
  for (const [relative, content] of files) {
    const target = path.join(root, relative!);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content!, 'utf8');
  }
}

function projectConfig(): Record<string, unknown> {
  return {
    project: 'demo',
    org: 'acme',
    language: 'en',
    platform: { type: 'github' },
    tuis: ['codex'],
    sandbox: { tools: ['agent-infra', 'claude-code'], customTools: [{ id: 'custom' }] },
    files: { managed: [], merged: [], ejected: [] }
  };
}

test('legacy state is normalized before enabled mutation and materialized canonically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-reconcile-plan-'));
  try {
    writeTemplates(root);
    const input = projectConfig();
    const before = structuredClone(input);
    const plan = planAgentClientReconciliation({
      config: input,
      mutation: { type: 'set-enabled', id: 'opencode', value: true },
      projectRoot: root,
      templateRoot: root,
      platformType: 'github',
      language: 'en'
    });

    assert.deepEqual(input, before);
    assert.equal(plan.source, 'legacy');
    assert.equal(plan.before.codex.enabled, true);
    assert.equal(plan.before.opencode.enabled, false);
    assert.equal(plan.desired.opencode.enabled, true);
    assert.equal(plan.desired.opencode.installInSandbox, false);
    assert.equal('tuis' in plan.nextConfig, false);
    assert.deepEqual(
      (plan.nextConfig.sandbox as { tools: string[] }).tools,
      ['agent-infra']
    );
    assert.deepEqual(
      (plan.nextConfig.agentClients as Array<{ id: string }>).map((entry) => entry.id),
      AGENT_CLIENT_IDS
    );
    assert.deepEqual(
      plan.seedOperations.filter((operation) => operation.kind === 'write').map((operation) => operation.clientId),
      ['opencode']
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical state without sandbox stays byte-stable for an unchanged mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-reconcile-no-sandbox-'));
  try {
    writeTemplates(root);
    const initial = planAgentClientReconciliation({
      config: {
        project: 'demo',
        org: 'acme',
        language: 'en',
        platform: { type: 'github' },
        agentClients: AGENT_CLIENT_IDS.map((id) => ({
          id,
          enabled: false,
          installInSandbox: true
        }))
      },
      mutation: { type: 'none' },
      projectRoot: root,
      templateRoot: root,
      platformType: 'github',
      language: 'en'
    });
    const config = structuredClone(initial.nextConfig);
    delete config.sandbox;

    const plan = planAgentClientReconciliation({
      config,
      mutation: { type: 'set-enabled', id: 'codex', value: false },
      projectRoot: root,
      templateRoot: root,
      platformType: 'github',
      language: 'en'
    });

    assert.equal(plan.changed, false);
    assert.deepEqual(plan.nextConfig, config);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executor writes planned seeds, commits config atomically, and converges on rerun', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-reconcile-apply-'));
  try {
    writeTemplates(root);
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    const config = projectConfig();
    fs.writeFileSync(path.join(root, '.agents/.airc.json'), `${JSON.stringify(config, null, 2)}\n`);

    const firstPlan = planAgentClientReconciliation({
      config,
      mutation: { type: 'set-enabled', id: 'opencode', value: true },
      projectRoot: root,
      templateRoot: root,
      platformType: 'github',
      language: 'en'
    });
    const result = applyAgentClientReconciliation(firstPlan);

    assert.equal(result.status, 'applied');
    assert.equal(result.configUpdated, true);
    assert.equal(
      fs.readFileSync(path.join(root, '.opencode/commands/update-agent-infra.md'), 'utf8'),
      'opencode demo'
    );

    const committed = JSON.parse(fs.readFileSync(path.join(root, '.agents/.airc.json'), 'utf8'));
    const secondPlan = planAgentClientReconciliation({
      config: committed,
      mutation: { type: 'none' },
      projectRoot: root,
      templateRoot: root,
      platformType: 'github',
      language: 'en'
    });
    assert.equal(secondPlan.changed, false);
    assert.equal(applyAgentClientReconciliation(secondPlan).status, 'unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabled user-modified seed is protected and config rename failure preserves original config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-reconcile-protect-'));
  try {
    writeTemplates(root);
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude/commands'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/commands/update-agent-infra.md'), 'user content');
    const config = projectConfig();
    const configPath = path.join(root, '.agents/.airc.json');
    const original = `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(configPath, original);

    const plan = planAgentClientReconciliation({
      config,
      mutation: { type: 'set-enabled', id: 'codex', value: false },
      projectRoot: root,
      templateRoot: root,
      platformType: 'github',
      language: 'en'
    });
    assert.equal(
      plan.seedOperations.find((operation) => operation.clientId === 'claude-code')?.kind,
      'protect'
    );

    assert.throws(() => applyAgentClientReconciliation(plan, {
      renameSync: () => { throw new Error('rename failed'); }
    }), /rename failed/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(root, '.claude/commands/update-agent-infra.md'), 'utf8'), 'user content');
    assert.deepEqual(
      fs.readdirSync(path.join(root, '.agents')).filter((entry) => entry.includes('.tmp-')),
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
