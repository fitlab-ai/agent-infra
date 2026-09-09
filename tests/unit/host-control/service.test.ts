import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { type TestContext } from 'node:test';

import { installHostControlService, type HostControlServicePlatform } from '../../../lib/host-control/service.ts';

function renderService(t: TestContext, executable: string, entry: string, platform: HostControlServicePlatform = 'linux'): string {
  const original = process.execPath;
  process.execPath = executable;
  t.after(() => { process.execPath = original; });
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs.realpathSync, 'native', () => entry);
  t.mock.method(fs, 'mkdirSync', () => undefined);
  t.mock.method(fs, 'chmodSync', () => undefined);
  const write = t.mock.method(fs, 'writeFileSync', () => undefined);
  const target = installHostControlService(platform);
  assert.equal(write.mock.callCount(), 1);
  const call = write.mock.calls[0];
  assert.ok(call);
  const [file, content, options] = call.arguments;
  assert.equal(file, target);
  assert.deepEqual(options, { mode: 0o600 });
  return String(content);
}

const paths = [
  { name: 'ordinary paths', value: '/opt/agent/bin', quoted: '"/opt/agent/bin"' },
  { name: 'spaces and unicode', value: '/opt/agent infra/工具', quoted: '"/opt/agent infra/工具"' },
  { name: 'quotes and backslashes', value: '/opt/"agent"\\infra', quoted: String.raw`"/opt/\"agent\"\\infra"` },
  { name: 'literal expansion markers', value: '/opt/${HOME}/$USER/%h/%%', quoted: '"/opt/${HOME}/$USER/%%h/%%%%"' },
  { name: 'line and control characters', value: '/opt/a\nb\rc\td\x01\x7f', quoted: String.raw`"/opt/a\x0ab\x0dc\x09d\x01\x7f"` }
];

for (const { name, value, quoted } of paths) {
  test(`Linux service preserves argv for ${name}`, (t) => {
    const unit = renderService(t, value, `${value}/internal-cli.js`);
    assert.equal(
      unit.split('\n').find((line) => line.startsWith('ExecStart=')),
      `ExecStart=":${quoted.slice(1)} ${quoted.slice(0, -1)}/internal-cli.js" host-control serve`
    );
  });
}

test('Linux service shares host temporary paths while retaining privilege restriction', (t) => {
  const unit = renderService(t, '/usr/bin/node', '/opt/agent/internal-cli.js');
  const section = unit.split('[Service]\n')[1];
  assert.ok(section);
  const service = section.split('\n[Install]')[0];
  assert.ok(service);
  const settings = Object.fromEntries(service.trim().split('\n').map((line) => line.split('=')));
  assert.equal(settings.PrivateTmp, 'false');
  assert.equal(settings.NoNewPrivileges, 'true');
  assert.equal(settings.Restart, 'on-failure');
});

test('macOS service retains XML ProgramArguments encoding', (t) => {
  const plist = renderService(t, '/opt/node & tools/node', '/opt/"agent"/$USER/%h/main.js', 'darwin');
  assert.ok(plist.includes([
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/opt/node &amp; tools/node</string>',
    '    <string>/opt/&quot;agent&quot;/$USER/%h/main.js</string>',
    '    <string>host-control</string>',
    '    <string>serve</string>',
    '  </array>'
  ].join('\n')));
});

test('service installation hardens the unit directory that already exists', (t) => {
  for (const platform of ['linux', 'darwin'] as const) {
    const original = process.execPath;
    process.execPath = '/opt/agent/bin/node';
    t.after(() => { process.execPath = original; });
    t.mock.method(fs, 'existsSync', () => true);
    t.mock.method(fs.realpathSync, 'native', () => '/opt/agent/bin/internal-cli.js');
    t.mock.method(fs, 'mkdirSync', () => undefined);
    t.mock.method(fs, 'writeFileSync', () => undefined);
    const chmod = t.mock.method(fs, 'chmodSync', () => undefined);
    const target = installHostControlService(platform);
    const directory = target.slice(0, target.lastIndexOf('/'));
    const modes = chmod.mock.calls.map((call) => call.arguments);
    assert.ok(modes.some(([file, mode]) => file === directory && mode === 0o700),
      `${platform} should restate 0700 on the service directory`);
    assert.ok(modes.some(([file, mode]) => file === target && mode === 0o600),
      `${platform} should keep the unit file at 0600`);
    t.mock.restoreAll();
  }
});
