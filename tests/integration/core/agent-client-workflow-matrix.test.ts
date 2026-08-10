import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { serializeAgentClients } from '../../../lib/agent-clients/config.ts';
import { planAgentClientReconciliation } from '../../../lib/agent-clients/reconcile.ts';
import { AGENT_CLIENT_IDS } from '../../../lib/agent-clients/types.ts';
import { getAgentClientAdapter } from '../../../lib/agent-clients/registry.ts';
import type { AgentClientState } from '../../../lib/agent-clients/types.ts';
import { filePath } from '../../helpers.ts';
import { loadFreshEsm } from '../../helpers/esm.ts';
import type { SyncTemplatesModule } from '../../helpers/esm.ts';

function stateFor(enabledMask: number, installMask: number): AgentClientState {
  return Object.fromEntries(AGENT_CLIENT_IDS.map((id, index) => [id, {
    enabled: (enabledMask & (1 << index)) !== 0,
    installInSandbox: (installMask & (1 << index)) !== 0
  }])) as AgentClientState;
}

test('all 16 project integration combinations stay equivalent across core and standalone contracts', async () => {
  const standalone = await loadFreshEsm<SyncTemplatesModule>(
    '.agents/skills/update-agent-infra/scripts/sync-templates.js'
  );
  const templateRoot = filePath('templates');

  for (let mask = 0; mask < 16; mask += 1) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-mask-${mask}-`));
    try {
      const installMask = ((mask << 1) | (mask >> 3)) & 0b1111;
      const state = stateFor(mask, installMask);
      const config = {
        project: 'demo',
        org: 'acme',
        language: 'en',
        platform: { type: 'github' },
        agentClients: serializeAgentClients(state),
        sandbox: { tools: ['agent-infra'] },
        files: { managed: [], merged: [], ejected: [] }
      };
      const plan = planAgentClientReconciliation({
        config,
        mutation: { type: 'none' },
        projectRoot,
        templateRoot,
        platformType: 'github',
        language: 'en'
      });
      const standaloneResult = standalone.normalizeAgentClientConfig(config);
      const enabled = AGENT_CLIENT_IDS.filter((id) => state[id].enabled);

      assert.deepEqual(plan.desired, state, `core state mask=${mask}`);
      assert.deepEqual(standaloneResult.state, state, `standalone state mask=${mask}`);
      assert.deepEqual(
        plan.nextSteps.filter((entry) => entry.source === 'builtin').map((entry) => entry.clientId),
        enabled,
        `next steps mask=${mask}`
      );
      assert.deepEqual(
        plan.seedOperations
          .filter((entry) => entry.kind === 'write')
          .map((entry) => entry.clientId),
        enabled.filter((id) => getAgentClientAdapter(id).project.seedCommands.length > 0),
        `seed plan mask=${mask}`
      );

      for (const id of AGENT_CLIENT_IDS) {
        const toggled = planAgentClientReconciliation({
          config,
          mutation: { type: 'set-enabled', id, value: !state[id].enabled },
          projectRoot,
          templateRoot,
          platformType: 'github',
          language: 'en'
        });
        assert.equal(toggled.desired[id].enabled, !state[id].enabled);
        assert.equal(
          toggled.desired[id].installInSandbox,
          state[id].installInSandbox,
          `sandbox dimension changed for ${id}, mask=${mask}`
        );
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
});
