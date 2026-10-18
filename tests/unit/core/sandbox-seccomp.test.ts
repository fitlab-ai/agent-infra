import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  sandboxSeccompArgs,
  sandboxSeccompProfilePath
} from '../../../lib/sandbox/seccomp.ts';

type SeccompRule = {
  names: string[];
  action: string;
  errnoRet?: number;
  args?: unknown[];
  includes?: { caps?: string[] };
  excludes?: { caps?: string[] };
};

type SeccompProfile = {
  defaultAction: string;
  syscalls: SeccompRule[];
};

function codexProfile(): SeccompProfile {
  const profilePath = sandboxSeccompProfilePath('codex');
  assert.ok(profilePath);
  return JSON.parse(fs.readFileSync(profilePath, 'utf8')) as SeccompProfile;
}

test('Codex seccomp profile keeps the Docker deny-by-default policy', () => {
  const profile = codexProfile();

  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  assert.ok(profile.syscalls.length > 0);
});

test('Codex seccomp profile relaxes only namespace and mount syscalls', () => {
  const profile = codexProfile();
  const unconditional = profile.syscalls.find((rule) => (
    rule.action === 'SCMP_ACT_ALLOW'
    && rule.includes === undefined
    && rule.excludes === undefined
    && rule.names.includes('unshare')
  ));
  assert.ok(unconditional);

  for (const name of [
    'unshare',
    'mount',
    'umount',
    'umount2',
    'move_mount',
    'open_tree',
    'mount_setattr',
    'fsconfig',
    'fsmount',
    'fsopen',
    'fspick',
    'pivot_root'
  ]) {
    assert.ok(unconditional.names.includes(name), name);
  }

  const unprivilegedCloneRules = profile.syscalls.filter((rule) => (
    rule.names.includes('clone')
    && rule.excludes?.caps?.includes('CAP_SYS_ADMIN')
  ));
  assert.ok(unprivilegedCloneRules.length > 0);
  for (const rule of unprivilegedCloneRules) {
    assert.equal(rule.args, undefined);
  }

  const privileged = profile.syscalls.find((rule) => (
    rule.action === 'SCMP_ACT_ALLOW'
    && rule.includes?.caps?.includes('CAP_SYS_ADMIN')
  ));
  assert.ok(privileged);

  for (const name of [
    'bpf',
    'clone3',
    'fanotify_init',
    'lookup_dcookie',
    'perf_event_open',
    'quotactl',
    'quotactl_fd',
    'setdomainname',
    'sethostname',
    'setns',
    'syslog'
  ]) {
    assert.ok(privileged.names.includes(name), name);
  }
  for (const name of ['unshare', 'mount', 'pivot_root']) {
    assert.equal(privileged.names.includes(name), false, name);
  }

  const clone3Fallback = profile.syscalls.find((rule) => (
    rule.names.includes('clone3') && rule.action === 'SCMP_ACT_ERRNO'
  ));
  assert.ok(clone3Fallback);
  assert.equal(clone3Fallback.errnoRet, 38);
});

test('sandboxSeccompArgs selects a profile only for Codex', () => {
  assert.deepEqual(sandboxSeccompArgs('docker-desktop', ['claude-code']), []);

  const args = sandboxSeccompArgs('docker-desktop', ['codex']);
  assert.equal(args.length, 2);
  assert.equal(args[0], '--security-opt');
  assert.match(args[1] ?? '', /^seccomp=.*codex-bwrap\.json$/);

  assert.deepEqual(sandboxSeccompArgs('docker-desktop', ['codex', 'codex']), args);
});
