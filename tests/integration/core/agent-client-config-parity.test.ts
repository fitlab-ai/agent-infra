import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  AgentClientConfigError,
  normalizeAgentClients
} from '../../../lib/agent-clients/config.ts';
import { filePath } from '../../helpers.ts';
import { loadFreshEsm } from '../../helpers/esm.ts';
import type { SyncTemplatesModule } from '../../helpers/esm.ts';

type FixtureCase = Readonly<{
  name: string;
  input: Record<string, unknown>;
}>;

function projectTypeScript(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const result = normalizeAgentClients(input);
    return {
      source: result.source,
      state: result.state,
      canonical: result.canonical,
      remainingSandboxTools: result.remainingSandboxTools ?? null,
      removeLegacyTuis: result.removeLegacyTuis,
      changed: result.changed,
      diagnostics: result.diagnostics,
      errorCode: null,
      errorPath: null
    };
  } catch (error) {
    assert.ok(error instanceof AgentClientConfigError);
    return { errorCode: error.code, errorPath: error.path };
  }
}

function projectStandalone(result: Record<string, unknown>): Record<string, unknown> {
  if (result.errorCode) {
    return { errorCode: result.errorCode, errorPath: result.errorPath };
  }
  return {
    source: result.source,
    state: result.state,
    canonical: result.canonical,
    remainingSandboxTools: result.remainingSandboxTools ?? null,
    removeLegacyTuis: result.removeLegacyTuis,
    changed: result.changed,
    diagnostics: result.diagnostics,
    errorCode: null,
    errorPath: null
  };
}

test('standalone and TypeScript Agent Client normalizers share the same contract vectors', async () => {
  const fixtures = JSON.parse(
    fs.readFileSync(filePath('tests/fixtures/agent-client-config-cases.json'), 'utf8')
  ) as FixtureCase[];
  const standalone = await loadFreshEsm<SyncTemplatesModule>(
    '.agents/skills/update-agent-infra/scripts/sync-templates.js'
  );

  for (const fixture of fixtures) {
    assert.deepEqual(
      projectStandalone(standalone.normalizeAgentClientConfig(structuredClone(fixture.input))),
      projectTypeScript(structuredClone(fixture.input)),
      fixture.name
    );
  }
});
