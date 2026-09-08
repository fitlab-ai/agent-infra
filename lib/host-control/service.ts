import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectHostControlEndpoint,
  resolveHostControlEndpoint,
  type HostControlPlatform
} from './path.ts';
import { serveHostControl, startHostControlServer, type HostControlDispatch, type RunningHostControlServer } from './server.ts';

export type HostControlServiceOptions = Readonly<{
  platform?: HostControlPlatform;
  uid?: number;
  username?: string;
  endpoint?: string;
  dispatch: HostControlDispatch;
  audit?: Parameters<typeof startHostControlServer>[0]['audit'];
}>;

export type HostControlServicePlatform = 'linux' | 'darwin' | 'unsupported';

function servicePlatform(): HostControlServicePlatform {
  if (process.platform === 'linux' || process.platform === 'darwin') return process.platform;
  return 'unsupported';
}

function serviceEntryPoint(): string {
  const compiled = fileURLToPath(new URL('../../bin/internal-cli.js', import.meta.url));
  if (fs.existsSync(compiled)) return fs.realpathSync.native(compiled);
  const candidate = process.argv[1];
  if (candidate && fs.existsSync(candidate)) return fs.realpathSync.native(candidate);
  return fs.realpathSync.native(fileURLToPath(new URL('../../bin/internal-cli.ts', import.meta.url)));
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function servicePaths(platform: HostControlServicePlatform = servicePlatform()): Readonly<{ unit?: string; plist?: string }> {
  if (platform === 'linux') return { unit: path.join(os.homedir(), '.config', 'systemd', 'user', 'agent-infra-host-control.service') };
  if (platform === 'darwin') return { plist: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.fitlab-ai.agent-infra.host-control.plist') };
  throw new Error('HOST_CONTROL_UNSUPPORTED_PLATFORM');
}

export function installHostControlService(platform: HostControlServicePlatform = servicePlatform()): string {
  const paths = servicePaths(platform);
  const entry = serviceEntryPoint();
  if (paths.unit) {
    fs.mkdirSync(path.dirname(paths.unit), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.unit, [
      '[Unit]',
      'Description=agent-infra host-control service',
      '',
      '[Service]',
      `ExecStart=${process.execPath} ${entry} host-control serve`,
      'Restart=on-failure',
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      '',
      '[Install]',
      'WantedBy=default.target',
      ''
    ].join('\n'), { mode: 0o600 });
    fs.chmodSync(paths.unit, 0o600);
    return paths.unit;
  }
  const plist = paths.plist!;
  fs.mkdirSync(path.dirname(plist), { recursive: true, mode: 0o700 });
  const argumentsXml = [process.execPath, entry, 'host-control', 'serve']
    .map((argument) => `    <string>${xml(argument)}</string>`)
    .join('\n');
  fs.writeFileSync(plist, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.fitlab-ai.agent-infra.host-control</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentsXml,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n'), { mode: 0o600 });
  fs.chmodSync(plist, 0o600);
  return plist;
}

export function uninstallHostControlService(platform: HostControlServicePlatform = servicePlatform()): string {
  const paths = servicePaths(platform);
  const target = paths.unit ?? paths.plist!;
  fs.rmSync(target, { force: true });
  return target;
}

export function hostControlServiceEndpoint(options: Pick<HostControlServiceOptions, 'platform' | 'uid' | 'username' | 'endpoint'> = {}): string {
  return options.endpoint ?? resolveHostControlEndpoint(options);
}

export async function startHostControlService(options: HostControlServiceOptions): Promise<RunningHostControlServer> {
  return startHostControlServer({ endpoint: hostControlServiceEndpoint(options), dispatch: options.dispatch, ...(options.audit ? { audit: options.audit } : {}) });
}

export async function serveHostControlService(options: HostControlServiceOptions, signal?: AbortSignal): Promise<void> {
  await serveHostControl({ endpoint: hostControlServiceEndpoint(options), dispatch: options.dispatch, ...(options.audit ? { audit: options.audit } : {}) }, signal);
}

export function hostControlServiceStatus(options: Pick<HostControlServiceOptions, 'platform' | 'uid' | 'username' | 'endpoint'> = {}): Readonly<{ endpoint: string; available: boolean; code: string | null }> {
  const endpoint = hostControlServiceEndpoint(options);
  const result = inspectHostControlEndpoint(endpoint, { uid: options.uid ?? process.getuid?.() });
  return { endpoint, available: result.ok, code: result.code };
}
