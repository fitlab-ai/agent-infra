import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  authorityVersionArgs,
  captureSandboxAuthority,
  commandForSandboxAuthority,
  verifySandboxAuthority
} from '../../../lib/sandbox/engines/authority.ts';

function probeResult(stdout: string, status = 0): any {
  return { status, signal: null, stdout, stderr: '', pid: 1, output: [] };
}

test('authority capture reads Docker version and daemon ID from their actual CLI responses', () => {
  const calls: string[][] = [];
  const evidence = captureSandboxAuthority('orbstack', {
    env: {},
    probe: (_cmd, args) => {
      calls.push(args);
      if (args.at(-1) === '{{json .Server}}') {
        return probeResult('{"Version":"29.4.0","ApiVersion":"1.54","MinAPIVersion":"1.40","Os":"linux","Arch":"arm64"}');
      }
      if (args.at(-1) === '{{json .ID}}') return probeResult('"sanitized-daemon-id"');
      throw new Error('Unexpected Docker command');
    }
  });
  assert.deepEqual(evidence.apiVersion, { major: 1, minor: 54 });
  assert.equal(evidence.daemonIdentity.fingerprint, createHash('sha256').update('sanitized-daemon-id').digest('hex'));
  assert.deepEqual(calls, [
    ['--context', 'orbstack', 'version', '--format', '{{json .Server}}'],
    ['--context', 'orbstack', 'info', '--format', '{{json .ID}}']
  ]);
});

test('authority recapture uses the persisted route for both queries and detects daemon drift', () => {
  const calls: string[][] = [];
  let daemonId = 'original-daemon';
  const probe = (_cmd: string, args: string[]) => {
    calls.push(args);
    return probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? daemonId : { ApiVersion: '1.54' }));
  };
  const original = captureSandboxAuthority('native', { env: { DOCKER_CONTEXT: 'original' }, probe });
  calls.length = 0;
  const recaptured = captureSandboxAuthority('native', {
    env: { DOCKER_CONTEXT: 'different' }, route: original, probe
  });
  assert.deepEqual(verifySandboxAuthority(original, recaptured), { state: 'verified' });
  assert.deepEqual(calls, [
    ['--context', 'original', 'version', '--format', '{{json .Server}}'],
    ['--context', 'original', 'info', '--format', '{{json .ID}}']
  ]);
  daemonId = 'replacement-daemon';
  const replacement = captureSandboxAuthority('native', { route: original, probe });
  assert.deepEqual(verifySandboxAuthority(original, replacement), {
    state: 'conflict', reason: 'SANDBOX_AUTHORITY_DRIFT'
  });
});

for (const command of ['version', 'info']) {
  for (const [label, response] of [
    ['nonzero', probeResult('{}', 1)],
    ['timeout', { ...probeResult(''), status: null, signal: 'SIGTERM' }],
    ['malformed JSON', probeResult('{')],
    ['missing value', probeResult('null')],
    ['invalid value', probeResult(command === 'version' ? '{"ApiVersion":"invalid"}' : '"  "')]
  ] as const) {
    test(`authority capture fails closed on ${command} ${label}`, () => {
      assert.throws(() => captureSandboxAuthority('native', {
        env: { DOCKER_CONTEXT: 'default' },
        probe: (_cmd, args) => args.includes(command)
          ? response
          : probeResult(JSON.stringify(args.includes('info') ? 'daemon-id' : { ApiVersion: '1.54' }))
      }), /SANDBOX_AUTHORITY_CAPTURE_FAILED/);
    });
  }
}

test('authority capture stores only redacted route and hashed daemon identity', () => {
  const calls: string[][] = [];
  const evidence = captureSandboxAuthority('native', {
    env: { DOCKER_HOST: 'tcp://user:secret@example.test:2376?token=hidden' },
    probe: (_cmd, args) => {
      calls.push(args);
      return probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-secret-id' : { ApiVersion: '1.50' }));
    }
  });

  assert.deepEqual(calls[0], ['--host', 'tcp://user:secret@example.test:2376?token=hidden', ...authorityVersionArgs()]);
  assert.equal(evidence.normalizedEndpoint.includes('secret'), false);
  assert.equal(evidence.normalizedEndpoint.includes('hidden'), false);
  assert.equal(evidence.daemonIdentity.fingerprint.includes('daemon-secret-id'), false);
  assert.equal(evidence.apiVersion.major, 1);
  assert.equal(evidence.apiVersion.minor, 50);
});

test('authority verification rejects route or daemon drift', () => {
  const capture = (host: string) => captureSandboxAuthority('native', {
    env: { DOCKER_HOST: host },
    lockDomain: 'a'.repeat(64),
    probe: (_cmd, args) => probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }))
  });
  const original = capture('unix:///run/user/1000/docker.sock');

  assert.deepEqual(verifySandboxAuthority(original, original), { state: 'verified' });
  assert.deepEqual(verifySandboxAuthority(original, capture('tcp://docker.example.test:2376')), {
    state: 'conflict',
    reason: 'SANDBOX_AUTHORITY_DRIFT'
  });
  assert.deepEqual(verifySandboxAuthority(null, original), {
    state: 'unknown',
    reason: 'SANDBOX_AUTHORITY_EVIDENCE_MISSING'
  });
});

test('persisted endpoint authority builds probes without reading the current route', () => {
  const evidence = captureSandboxAuthority('native', {
    env: { DOCKER_HOST: 'tcp://docker.example.test:2376' },
    probe: (_cmd, args) => probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }))
  });

  assert.deepEqual(commandForSandboxAuthority(evidence, 'docker', ['container', 'ls']), {
    cmd: 'docker',
    args: ['--host', 'tcp://docker.example.test:2376', 'container', 'ls']
  });
});

test('authority capture persists the effective native Docker context and replays it', () => {
  const calls: string[][] = [];
  const evidence = captureSandboxAuthority('native', {
    env: { DOCKER_CONTEXT: 'remote-prod' },
    probe: (_cmd, args) => {
      calls.push(args);
      return probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }));
    }
  });

  assert.deepEqual(calls[0], ['--context', 'remote-prod', ...authorityVersionArgs()]);
  assert.equal(evidence.routeKind, 'context');
  assert.deepEqual(evidence.routeSelector, { context: 'remote-prod' });
  assert.deepEqual(commandForSandboxAuthority(evidence, 'docker', ['ps']), {
    cmd: 'docker', args: ['--context', 'remote-prod', 'ps']
  });
});

test('authority capture resolves the current native context before persisting it', () => {
  const calls: string[][] = [];
  const evidence = captureSandboxAuthority('native', {
    env: {},
    probe: (_cmd, args) => {
      calls.push(args);
      return args[0] === 'context'
        ? probeResult('remote-current\n')
        : probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }));
    }
  });

  assert.deepEqual(calls, [
    ['context', 'show'],
    ['--context', 'remote-current', ...authorityVersionArgs()],
    ['--context', 'remote-current', 'info', '--format', '{{json .ID}}']
  ]);
  assert.deepEqual(commandForSandboxAuthority(evidence, 'docker', ['ps']), {
    cmd: 'docker', args: ['--context', 'remote-current', 'ps']
  });
});

test('credentialed Docker hosts are redacted and cannot be replayed', () => {
  const evidence = captureSandboxAuthority('native', {
    env: { DOCKER_HOST: 'tcp://user:secret@example.test:2376?token=hidden' },
    probe: (_cmd, args) => probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }))
  });

  assert.match(evidence.routeSelector.endpoint ?? '', /<redacted>/u);
  assert.throws(
    () => commandForSandboxAuthority(evidence, 'docker', ['ps']),
    /SANDBOX_AUTHORITY_ROUTE_UNREPLAYABLE/
  );
});

test('query-only Docker hosts are redacted and cannot be replayed', () => {
  const evidence = captureSandboxAuthority('native', {
    env: { DOCKER_HOST: 'tcp://docker.example.test:2376?token=hidden' },
    probe: (_cmd, args) => probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }))
  });

  assert.match(evidence.routeSelector.endpoint ?? '', /<redacted>/u);
  assert.throws(
    () => commandForSandboxAuthority(evidence, 'docker', ['ps']),
    /SANDBOX_AUTHORITY_ROUTE_UNREPLAYABLE/
  );
});

test('Docker TLS environment is marked unreplayable', () => {
  const evidence = captureSandboxAuthority('native', {
    env: {
      DOCKER_HOST: 'tcp://docker.example.test:2376',
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: '/run/secrets/docker'
    },
    probe: (_cmd, args) => probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }))
  });

  assert.equal(evidence.routeSelector.unreplayable, 'tls-environment');
  assert.throws(
    () => commandForSandboxAuthority(evidence, 'docker', ['ps']),
    /SANDBOX_AUTHORITY_ROUTE_UNREPLAYABLE/
  );
});

test('WSL default route persists the actual distribution and context', () => {
  const evidence = captureSandboxAuthority('wsl2', {
    env: {},
    probe: (_cmd, args) => args[0] === '--list'
      ? probeResult('  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  Debian    Stopped         2\n')
      : args.at(-2) === 'context' && args.at(-1) === 'show'
        ? probeResult('docker-desktop\n')
        : probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }))
  });

  assert.deepEqual(evidence.routeSelector, { distro: 'Ubuntu', context: 'docker-desktop' });
  assert.deepEqual(commandForSandboxAuthority(evidence, 'docker', ['ps']), {
    cmd: 'wsl.exe', args: ['--distribution', 'Ubuntu', '--exec', 'docker', '--context', 'docker-desktop', 'ps']
  });
});

test('WSL explicit distro and context are replayed without ambient defaults', () => {
  const calls: string[][] = [];
  const evidence = captureSandboxAuthority('wsl2', {
    env: { WSL_DISTRO_NAME: 'Ubuntu', DOCKER_CONTEXT: 'remote-prod' },
    probe: (_cmd, args) => {
      calls.push(args);
      return probeResult(JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }));
    }
  });

  assert.deepEqual(calls, [[
    '--distribution', 'Ubuntu', '--exec', 'docker', '--context', 'remote-prod', ...authorityVersionArgs()
  ], [
    '--distribution', 'Ubuntu', '--exec', 'docker', '--context', 'remote-prod', 'info', '--format', '{{json .ID}}'
  ]]);
  assert.deepEqual(commandForSandboxAuthority(evidence, 'docker', ['ps']), {
    cmd: 'wsl.exe', args: ['--distribution', 'Ubuntu', '--exec', 'docker', '--context', 'remote-prod', 'ps']
  });
});
