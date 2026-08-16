import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentClientState } from '../../../lib/agent-clients/types.ts';
import { getAgentClientAdapter } from '../../../lib/agent-clients/registry.ts';
import type {
  AgentClientSandboxHook,
  SandboxTool
} from '../../../lib/sandbox/tool-types.ts';
import {
  createSandboxCapabilityPlan,
  runSandboxHooks,
  sandboxImageContribution
} from '../../../lib/sandbox/agent-client-reconciler.ts';
import { classifySandboxRecovery } from '../../../lib/sandbox/recovery.ts';

function stateWithInstalled(installed: readonly string[]): AgentClientState {
  return {
    'claude-code': {
      enabled: true,
      installInSandbox: installed.includes('claude-code')
    },
    codex: {
      enabled: false,
      installInSandbox: installed.includes('codex')
    },
    'antigravity-cli': {
      enabled: true,
      installInSandbox: installed.includes('antigravity-cli')
    },
    opencode: {
      enabled: false,
      installInSandbox: installed.includes('opencode')
    }
  };
}

function config(installed: readonly string[], tools: readonly string[] = ['agent-infra']) {
  return {
    home: '/host/alice',
    project: 'demo',
    tools: [...tools],
    customTools: [],
    agentClientState: stateWithInstalled(installed)
  };
}

test('capability plan selects clients only from installInSandbox while preserving non-client tools', () => {
  const plan = createSandboxCapabilityPlan(config(['codex']));

  assert.deepEqual(plan.selectedAgentClients.map((adapter) => adapter.id), ['codex']);
  assert.deepEqual(plan.tools.map((tool) => tool.id), ['agent-infra', 'codex']);
  assert.equal(plan.tools.some((tool) => tool.id === 'antigravity-cli'), false);
  assert.deepEqual(
    plan.hooksByPhase['before-container-create'].map((hook) => hook.id),
    ['codex-before-container-create']
  );
  assert.deepEqual(
    plan.recoveryChecks.map(({ adapterId, check }) => `${adapterId}:${check.id}`),
    [
      'codex:command-available',
      'codex:state-writable',
      'codex:prompts-link'
    ]
  );
});

test('canonical all-false state does not fall back to legacy client tool ids', () => {
  const plan = createSandboxCapabilityPlan(config([], [
    'agent-infra',
    'claude-code',
    'codex',
    'antigravity-cli',
    'opencode'
  ]));

  assert.deepEqual(plan.selectedAgentClients, []);
  assert.deepEqual(plan.tools.map((tool) => tool.id), ['agent-infra']);
});

test('Claude sandbox lifecycle is selected only by installInSandbox', () => {
  const installed = createSandboxCapabilityPlan(config(['claude-code']));
  const disabled = createSandboxCapabilityPlan(config([]));

  assert.deepEqual(
    Object.values(installed.hooksByPhase).flat().map(({ id, phase }) => ({ id, phase })),
    [
      { id: 'claude-code-credential-preflight', phase: 'prepare' },
      { id: 'claude-code-before-container-create', phase: 'before-container-create' },
      { id: 'claude-code-before-enter', phase: 'before-enter' }
    ]
  );
  assert.deepEqual(Object.values(disabled.hooksByPhase).flat(), []);
});

test('capability image contributions derive selected client mounts and adapter extras', () => {
  const empty = createSandboxCapabilityPlan(config([]));
  const claude = createSandboxCapabilityPlan(config(['claude-code']));
  const all = createSandboxCapabilityPlan(config([
    'claude-code',
    'codex',
    'antigravity-cli',
    'opencode'
  ]));
  const imageOf = (plan: unknown) => (plan as {
    image: Readonly<{
      dockerfileFragments: readonly string[];
      dotfilesExclusions: readonly string[];
    }>;
  }).image;

  assert.deepEqual(imageOf(empty), {
    dockerfileFragments: [],
    dotfilesExclusions: []
  });
  assert.deepEqual(imageOf(claude), {
    dockerfileFragments: ['claude-code'],
    dotfilesExclusions: ['.claude']
  });
  assert.deepEqual(imageOf(all), {
    dockerfileFragments: ['claude-code'],
    dotfilesExclusions: [
      '.claude',
      '.codex',
      '.gemini',
      '.local/share/opencode',
      '.config/opencode'
    ]
  });
  assert.ok(Object.isFrozen(imageOf(all)));
  assert.ok(Object.isFrozen(imageOf(all).dockerfileFragments));
  assert.ok(Object.isFrozen(imageOf(all).dotfilesExclusions));
  assert.deepEqual(
    (all.runtimeProjection as typeof all.runtimeProjection & { image: unknown }).image,
    imageOf(all)
  );
});

test('capability image contributions reject client mounts outside the container home', () => {
  const adapter = getAgentClientAdapter('codex');
  const tool = {
    ...adapter.sandbox.createTool({ home: '/host/alice', project: 'demo' }),
    containerMount: '/var/lib/codex'
  };

  assert.throws(
    () => sandboxImageContribution([adapter], [tool]),
    /Agent Client 'codex' container mount must be below \/home\/devuser/
  );
});

test('runtime signature is host-path independent and changes with selected capabilities', () => {
  const first = createSandboxCapabilityPlan(config(['codex']));
  const movedHome = createSandboxCapabilityPlan({
    ...config(['codex']),
    home: '/different/home'
  });
  const changedSelection = createSandboxCapabilityPlan(config(['claude-code']));

  assert.equal(first.runtimeSignature, movedHome.runtimeSignature);
  assert.notEqual(first.runtimeSignature, changedSelection.runtimeSignature);
  assert.equal(JSON.stringify(first.runtimeProjection).includes('/host/alice'), false);
  assert.deepEqual(
    first.runtimeProjection.recoveryChecks.map((check) => ({
      keys: Object.keys(check),
      finding: check.finding
    })),
    [
      {
        keys: ['adapterId', 'id', 'probe', 'finding'],
        finding: { repairKind: 'hard-failure' }
      },
      {
        keys: ['adapterId', 'id', 'probe', 'finding'],
        finding: { repairKind: 'permissions', path: '/home/devuser/.codex' }
      },
      {
        keys: ['adapterId', 'id', 'when', 'probe', 'finding', 'repair'],
        finding: { repairKind: 'builtin-link', path: '/home/devuser/.codex/prompts' }
      }
    ]
  );
});

test('cleanup inventory includes every registered client independent of selection', () => {
  const empty = createSandboxCapabilityPlan(config([]));
  const full = createSandboxCapabilityPlan(config([
    'claude-code',
    'codex',
    'antigravity-cli',
    'opencode'
  ]));

  assert.deepEqual(
    empty.cleanupInventory.map((tool) => tool.id),
    full.cleanupInventory.map((tool) => tool.id)
  );
  assert.deepEqual(
    empty.cleanupInventory.map((tool) => tool.id),
    ['agent-infra', 'claude-code', 'codex', 'antigravity-cli', 'opencode']
  );
});

test('hook runner preserves declaration order and clears deadlines after completion', async () => {
  const events: string[] = [];
  const cleared: unknown[] = [];
  const hooks: AgentClientSandboxHook[] = [
    {
      id: 'first',
      phase: 'prepare',
      run: async () => {
        events.push('first');
        return { status: 'ready' };
      }
    },
    {
      id: 'second',
      phase: 'prepare',
      run: async () => {
        events.push('second');
        return { status: 'ready' };
      }
    }
  ];

  const results = await runSandboxHooks({
    hooks,
    phase: 'prepare',
    context: {},
    scheduleTimeout: () => ({ timer: true }),
    clearScheduledTimeout: (handle) => {
      cleared.push(handle);
    }
  });

  assert.deepEqual(events, ['first', 'second']);
  assert.deepEqual(results.map((result) => result.status), ['ready', 'ready']);
  assert.equal(cleared.length, 2);
});

test('hook timeout aborts the hook and maps to the phase failure policy', async () => {
  let triggerTimeout: (() => void) | undefined;
  let observedSignal: AbortSignal | undefined;
  const hook: AgentClientSandboxHook = {
    id: 'stuck',
    phase: 'before-container-create',
    timeoutMs: 12,
    run: async (context) => {
      observedSignal = context.signal;
      return await new Promise(() => {});
    }
  };

  const pending = runSandboxHooks({
    hooks: [hook],
    phase: 'before-container-create',
    context: {},
    scheduleTimeout: (callback) => {
      triggerTimeout = callback;
      return 1;
    },
    clearScheduledTimeout: () => {}
  });
  triggerTimeout?.();
  const results = await pending;

  assert.equal(observedSignal?.aborted, true);
  assert.deepEqual(results, [{
    hookId: 'stuck',
    phase: 'before-container-create',
    status: 'fatal',
    message: "Sandbox hook 'stuck' timed out after 12ms."
  }]);
});

test('custom tools remain independent from Agent Client selection', () => {
  const customTool: SandboxTool = {
    id: 'git-lfs',
    name: 'Git LFS',
    install: { type: 'shell', cmd: 'install-git-lfs' },
    sandboxBase: '/host/alice/.agent-infra/sandboxes/git-lfs',
    containerMount: '/home/devuser/.git-lfs',
    versionCmd: 'git lfs version',
    setupHint: 'Ready'
  };
  const plan = createSandboxCapabilityPlan({
    ...config([]),
    tools: ['agent-infra', 'git-lfs'],
    customTools: [customTool]
  });

  assert.deepEqual(plan.tools.map((tool) => tool.id), ['agent-infra', 'git-lfs']);
});

test('recovery treats a stale runtime signature and disabled client mount as hard failures', () => {
  const findings = classifySandboxRecovery({
    identityOk: true,
    containerIdValid: true,
    expectedBranch: 'feature/demo',
    actualBranch: 'feature/demo',
    expectedWorkspace: { mode: 'branch-only' },
    actualWorkspace: { mode: 'branch-only' },
    runtimeCapabilityOk: false,
    unexpectedCapabilityMounts: ['/home/devuser/.claude'],
    mounts: [],
    tmpfs: [],
    seeds: [],
    aliasesReadable: true,
    agentClientChecks: []
  });

  assert.deepEqual(
    findings.map((finding) => ({
      repairKind: finding.repairKind,
      path: finding.path
    })),
    [
      { repairKind: 'hard-failure', path: undefined },
      { repairKind: 'hard-failure', path: '/home/devuser/.claude' }
    ]
  );
});
