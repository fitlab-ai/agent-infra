import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentClientSandboxHook,
  SandboxHookCreateContext,
  SandboxHookEnterContext
} from '../../sandbox/tool-types.ts';
import {
  formatCredentialWarnings,
  formatRemaining,
  hasClaudeProviderAuth,
  inspectClaudeKeychainStatus,
  prepareClaudeCredentials,
  reconcileClaudeCredentials,
  redactCommandError,
  validateClaudeCredentialsEnvOverride
} from './claude-code-credentials.ts';

type JsonObject = Record<string, unknown>;

function readHostJsonSafe(filePath: string): JsonObject | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

const CLAUDE_SETTINGS_INHERIT_TOP_LEVEL_KEYS = [
  'model',
  'fallbackModel',
  'availableModels',
  'modelOverrides',
  'enforceAvailableModels',
  'advisorModel',
  'apiKeyHelper',
  'effortLevel'
];

function isJsonObjectRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeMissingStringEnvFields(target: JsonObject, source: JsonObject): boolean {
  if (!isJsonObjectRecord(source.env)) return false;
  if (Object.hasOwn(target, 'env') && !isJsonObjectRecord(target.env)) return false;

  let targetEnv = target.env as JsonObject | undefined;
  let changed = false;
  for (const [key, value] of Object.entries(source.env)) {
    if (typeof value !== 'string' || value === '') continue;
    if (!targetEnv) {
      targetEnv = {};
      target.env = targetEnv;
    }
    if (!Object.hasOwn(targetEnv, key)) {
      targetEnv[key] = value;
      changed = true;
    }
  }
  return changed;
}

function mergeMissingTopLevelSettings(target: JsonObject, source: JsonObject): boolean {
  let changed = false;
  for (const key of CLAUDE_SETTINGS_INHERIT_TOP_LEVEL_KEYS) {
    if (!Object.hasOwn(source, key) || Object.hasOwn(target, key)) continue;
    const value = source[key];
    if (value === null || value === undefined || value === '') continue;
    target[key] = value;
    changed = true;
  }
  return changed;
}

function requireCreateContext(
  context: SandboxHookCreateContext | undefined,
  hookId: string
): SandboxHookCreateContext {
  if (!context) throw new Error(`${hookId} requires create context`);
  return context;
}

function requireEnterContext(
  context: SandboxHookEnterContext | undefined,
  hookId: string
): SandboxHookEnterContext {
  if (!context) throw new Error(`${hookId} requires enter context`);
  return context;
}

export function ensureClaudeOnboarding(toolDir: string, hostHomeDir?: string): void {
  const claudeJsonPath = path.join(toolDir, '.claude.json');
  let data: JsonObject & {
    hasCompletedOnboarding?: boolean;
    projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    model?: string;
  } = {};
  if (fs.existsSync(claudeJsonPath)) {
    try {
      data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as typeof data;
    } catch {
      // Malformed JSON is replaced with a valid managed sandbox baseline.
    }
  }
  let changed = false;
  if (!data.hasCompletedOnboarding) {
    data.hasCompletedOnboarding = true;
    changed = true;
  }
  if (!data.projects) {
    data.projects = {};
    changed = true;
  }
  if (!data.projects['/workspace']) {
    data.projects['/workspace'] = {};
    changed = true;
  }
  if (!data.projects['/workspace'].hasTrustDialogAccepted) {
    data.projects['/workspace'].hasTrustDialogAccepted = true;
    changed = true;
  }
  if (hostHomeDir) {
    const hostClaudeJson = readHostJsonSafe(path.join(hostHomeDir, '.claude.json'));
    if (
      hostClaudeJson
      && typeof hostClaudeJson.model === 'string'
      && hostClaudeJson.model !== ''
      && !Object.hasOwn(data, 'model')
    ) {
      data.model = hostClaudeJson.model;
      changed = true;
    }
    if (hostClaudeJson) {
      for (const key of Object.keys(hostClaudeJson)) {
        if (
          /^unpin.*LaunchEffort$/.test(key)
          && hostClaudeJson[key] === true
          && !Object.hasOwn(data, key)
        ) {
          data[key] = true;
          changed = true;
        }
      }
    }
  }
  if (changed) fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 4), 'utf8');
}

export function ensureClaudeSettings(toolDir: string, hostHomeDir?: string): void {
  const settingsPath = path.join(toolDir, 'settings.json');
  let data: JsonObject & { skipDangerousModePermissionPrompt?: boolean } = {};
  if (fs.existsSync(settingsPath)) {
    try {
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as typeof data;
    } catch {
      // Malformed JSON is replaced with a valid managed sandbox baseline.
    }
  }
  let changed = false;
  if (data.skipDangerousModePermissionPrompt !== true) {
    data.skipDangerousModePermissionPrompt = true;
    changed = true;
  }
  if (hostHomeDir) {
    const hostSettings = readHostJsonSafe(path.join(hostHomeDir, '.claude', 'settings.json'));
    if (hostSettings) {
      changed = mergeMissingStringEnvFields(data, hostSettings) || changed;
      changed = mergeMissingTopLevelSettings(data, hostSettings) || changed;
    }
  }
  if (changed) fs.writeFileSync(settingsPath, JSON.stringify(data, null, 4), 'utf8');
}

export function formatCredentialSyncStatus(
  result: ReturnType<typeof reconcileClaudeCredentials>,
  isTTY = process.stderr.isTTY,
  providerAuthAvailable = false
): string | null {
  if (providerAuthAvailable && (result.status === 'STALE_ACCESS' || result.status === 'MISSING')) return null;
  if (result.status === 'STALE_ACCESS') {
    return 'Warning: Claude Code credentials on host appear stale. Run "ai sandbox refresh" or "claude /login" to renew.\n';
  }
  if (result.status === 'MISSING') {
    return 'Warning: Claude Code credentials missing on host. Run "claude /login" to authenticate.\n';
  }
  if (result.status === 'KEYCHAIN_WRITE_FAILED') {
    return `Warning: A sandbox refresh produced newer credentials but host Keychain write failed (${formatCredentialWarnings(result.warnings)}). Run "ai sandbox refresh" again or "claude /status" on the host to retry.\n`;
  }
  if (result.status === 'KEYCHAIN_LOCKED' || result.status === 'KEYCHAIN_ERROR') {
    return 'Warning: Host keychain is unavailable; Claude credential sync skipped. Run "ai sandbox refresh" for details.\n';
  }
  if (result.status === 'OK' && result.authoritative !== 'host') {
    const message = `Synced Claude Code credentials from sandbox refresh back to host (expires in ${formatRemaining(result.expiresAt)})`;
    return isTTY ? `\x1b[2m${message}\x1b[0m\n` : `${message}\n`;
  }
  if (result.status === 'OK' && result.filesWritten.length > 0) {
    const message = `Synced Claude Code credentials from host Keychain (expires in ${formatRemaining(result.expiresAt)})`;
    return isTTY ? `\x1b[2m${message}\x1b[0m\n` : `${message}\n`;
  }
  return null;
}

const claudeCodeCredentialPreflightHook: AgentClientSandboxHook = {
  id: 'claude-code-credential-preflight',
  phase: 'prepare',
  run: async ({ create }) => {
    const { hostHome, hostEnv, project, resolvedTools } = requireCreateContext(
      create,
      'claude-code-credential-preflight'
    );
    try {
      validateClaudeCredentialsEnvOverride(hostEnv);
      const outcome = prepareClaudeCredentials(
        hostHome,
        project,
        [...resolvedTools],
        undefined,
        undefined,
        (home) => inspectClaudeKeychainStatus(home, undefined, { envFn: () => ({ ...hostEnv }) })
      );
      if (outcome.status === 'SKIPPED') {
        return {
          status: 'warning',
          message: 'Claude Code credentials not found on host - creating this sandbox WITHOUT Claude Code credentials.\n'
            + '  Claude Code is still installed in the image but will not be authenticated.\n'
            + '  To enable it: run "claude" once on the host to complete login, then re-run "ai sandbox create".'
        };
      }
      return { status: 'ready' };
    } catch (error) {
      return {
        status: 'fatal',
        message: redactCommandError(error instanceof Error ? error.message : 'unknown credential error')
      };
    }
  }
};

const claudeCodeBeforeContainerCreateHook: AgentClientSandboxHook = {
  id: 'claude-code-before-container-create',
  phase: 'before-container-create',
  run: async ({ create }) => {
    const { hostHome, resolvedTools } = requireCreateContext(
      create,
      'claude-code-before-container-create'
    );
    const claudeCodeEntry = resolvedTools.find(({ tool }) => tool.id === 'claude-code');
    if (claudeCodeEntry) {
      ensureClaudeOnboarding(claudeCodeEntry.dir, hostHome);
      ensureClaudeSettings(claudeCodeEntry.dir, hostHome);
    }
    return { status: 'ready' };
  }
};

const claudeCodeBeforeEnterHook: AgentClientSandboxHook = {
  id: 'claude-code-before-enter',
  phase: 'before-enter',
  run: async ({ enter }) => {
    const { hostHome, hostEnv } = requireEnterContext(enter, 'claude-code-before-enter');
    try {
      validateClaudeCredentialsEnvOverride(hostEnv);
    } catch (error) {
      return {
        status: 'fatal',
        message: redactCommandError(error instanceof Error ? error.message : 'invalid credentials override')
      };
    }
    try {
      const providerAuthAvailable = hasClaudeProviderAuth(hostHome);
      const result = reconcileClaudeCredentials(hostHome, { envFn: () => ({ ...hostEnv }) });
      const message = formatCredentialSyncStatus(result, process.stderr.isTTY, providerAuthAvailable);
      return {
        status: 'ready',
        ...(message === null ? {} : { message })
      };
    } catch (error) {
      return {
        status: 'warning',
        message: `Failed to sync Claude Code credentials: ${redactCommandError(error instanceof Error ? error.message : 'unknown error')}`
      };
    }
  }
};

export {
  claudeCodeBeforeContainerCreateHook,
  claudeCodeBeforeEnterHook,
  claudeCodeCredentialPreflightHook
};
