/**
 * sync-templates.js — Deterministic template sync for managed & ejected files.
 *
 * Handles SKILL steps: 2 (detect template source version), 3.0 (registry sync), 4 (managed),
 * 6 (ejected), 7 (.agents/.airc.json update).
 *
 * Merged files (step 5) are NOT handled — they require AI semantic merge.
 * The report includes `merged.pending` so the AI knows what to process.
 *
 * Usage:
 *   node .agents/skills/update-agent-infra/scripts/sync-templates.js [project-root]
 *
 * Output: JSON report to stdout.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatAgentInfraPackageError,
  resolveAgentInfraPackage
} from '../../../scripts/lib/agent-infra-package.js';

const DEFAULTS = {
  "platform": {
    "type": "github"
  },
  "agentClients": [
    {
      "id": "claude-code",
      "enabled": true,
      "installInSandbox": true
    },
    {
      "id": "codex",
      "enabled": true,
      "installInSandbox": true
    },
    {
      "id": "antigravity-cli",
      "enabled": true,
      "installInSandbox": true
    },
    {
      "id": "opencode",
      "enabled": true,
      "installInSandbox": true
    }
  ],
  "sandbox": {
    "engine": null,
    "runtimes": [
      "node22"
    ],
    "tools": [
      "agent-infra"
    ],
    "refreshIntervalDays": 7,
    "dockerfile": null,
    "vm": {
      "cpu": null,
      "memory": null,
      "disk": null
    }
  },
  "task": {
    "shortIdLength": 2
  },
  "labels": {
    "in": {}
  },
  "files": {
    "managed": [
      ".agents/QUICKSTART.md",
      ".agents/README.md",
      ".agents/hooks/",
      ".agents/rules/",
      ".agents/scripts/",
      ".agents/skills/",
      ".agents/templates/",
      ".agents/workflows/",
      ".agents/workspace/README.md",
      ".git-hooks/check-large-files.cjs",
      ".git-hooks/check-version-format.sh",
      ".github/scripts/",
      ".github/workflows/metadata-sync.yml",
      ".github/workflows/pr-label.yml",
      ".github/workflows/status-label.yml"
    ],
    "guardedManaged": [
      ".github/workflows/metadata-sync.yml",
      ".github/workflows/pr-label.yml",
      ".github/workflows/status-label.yml"
    ],
    "merged": [
      "**/post-release.*",
      "**/release.*",
      "**/test-integration.*",
      "**/test.*",
      "**/upgrade-dependency.*",
      ".agents/rules/testing-discipline.*",
      ".agents/skills/post-release/SKILL.*",
      ".agents/skills/release/SKILL.*",
      ".agents/skills/test-integration/SKILL.*",
      ".agents/skills/test/SKILL.*",
      ".agents/skills/upgrade-dependency/SKILL.*",
      ".git-hooks/pre-commit",
      ".gitignore"
    ],
    "ejected": []
  }
};

const AGENT_CLIENT_MANIFEST = [
  {
    "id": "claude-code",
    "displayName": "Claude Code",
    "invocation": "/${skillName}",
    "ownedPathPrefixes": [
      ".claude/"
    ],
    "managed": [
      ".claude/commands/",
      ".claude/agents/"
    ],
    "merged": [
      ".claude/settings.json"
    ],
    "ejected": []
  },
  {
    "id": "codex",
    "displayName": "Codex",
    "invocation": "$${skillName}",
    "ownedPathPrefixes": [
      ".codex/"
    ],
    "managed": [
      ".codex/hooks.json",
      ".codex/agents/"
    ],
    "merged": [],
    "ejected": []
  },
  {
    "id": "antigravity-cli",
    "displayName": "Antigravity CLI",
    "invocation": "/${skillName}",
    "ownedPathPrefixes": [],
    "managed": [],
    "merged": [],
    "ejected": []
  },
  {
    "id": "opencode",
    "displayName": "OpenCode",
    "invocation": "/${skillName}",
    "ownedPathPrefixes": [
      ".opencode/"
    ],
    "managed": [
      ".opencode/commands/"
    ],
    "merged": [],
    "ejected": []
  }
];
const CUSTOM_TUI_CONTRACT = {
  "requiredFields": [
    "name",
    "dir",
    "invoke"
  ],
  "allowedPlaceholders": [
    "skillName",
    "projectName"
  ]
};
const RETIRED_GEMINI_COMMAND_HASHES = {
  "analyze-task": [
    "sha256:24b7b1ae2aa8ac4f80a92ca4db8c7f4f6667088423c59097a94d8d2111fb9c3e",
    "sha256:922d525fd71db45ee4b635b25e10aff9c4b0b327e19b97cd7f8164c484507729"
  ],
  "archive-tasks": [
    "sha256:c5687321142d2a11269eeab1c204b82673d7792301df937f84866b9c20e4cf0f",
    "sha256:4f3f3273bf3a956898e188e26766080d10fa9f5d2a25d309877f9ba1cb8d30e1"
  ],
  "block-task": [
    "sha256:d4a983c21335f12964559f0d0c88ecd6071e1466e8944f14cd708d940db2d621",
    "sha256:d17da9fbd6770e9e62d3e40ad2ec837f876c1967737c19074d2b328bdc092ae8"
  ],
  "cancel-task": [
    "sha256:0e677f94067e6b7ce1f42ce8ba04435d1113515f1cad1783829639269081e95b",
    "sha256:4161e9694b5c20ccfc1e83fb2a7cebcf271421cc1ef0983adafad865c6067c96"
  ],
  "check-task": [
    "sha256:cfdeae9c601427b60911ea75250fb649bd800c47a10383c4c25da11261084725",
    "sha256:486e42f97837c3214474a3432f2c2518f40bdbafaff53ed45d31e4e14e472085"
  ],
  "close-codescan": [
    "sha256:c4b5e0591e5e4b1346c2b3d356431916d3ceb30788fc106d613642c750ef45ee",
    "sha256:4643a8ab8ea5decb0c35335ff8ff3e862eba27f126adf25af8d2f7916fe5a7e0"
  ],
  "close-dependabot": [
    "sha256:9614b090ab5470cf42ef0533d80406fe3e337b1dac88b31782a1bc730fb034e3",
    "sha256:41df85a134472fca4527020b3463501b190b81287fd6b63c8ea0c07f5cc2c7ef"
  ],
  "code-task": [
    "sha256:51c7f4d62d39c7d229abc204c4b4ba22588bcf27aec10c1ddce4526aa5beb9c2",
    "sha256:250771c74f6a611834519a4904f5ca1532ae7ef63f0fed554db863383ec93e7b"
  ],
  "commit": [
    "sha256:959feec8adcc9904b91fe9dd4474e0afe1f357d5b5d15716d401677de4ded5c1",
    "sha256:ff394348ca3115bb853135df3c0f559a83103cf433872eebd43b06066516773b"
  ],
  "complete-manual-validation": [
    "sha256:9e6b973bf9fb735c96cce0d3af41d3d164c3ad77a52d2b4ec3e855ba6ac9d6e7",
    "sha256:c867cdaf7c3a280d9b5eefc6dbb914f9bbaefd73dc6265acfd2343bdcb81892b"
  ],
  "complete-task": [
    "sha256:10ec96d53d467429238a3f96a137bec670ca77dea44df7918e4be09a1f452ef8",
    "sha256:275c03ded3d60073860fd5eea4bd4c614d1a8ee58297a6f1d8fe90cab6cbebcc"
  ],
  "create-pr": [
    "sha256:bb976e9795b463160e2bd7a4e3f8444bdec1c63255dd85d38a9ebf5620bc947f",
    "sha256:4e2b7e422aa481f155b8133c84694850890258fdaa852feff4cc2875e8971f6b"
  ],
  "create-release-note": [
    "sha256:39d21f498bbd606bcb8469a4ee68666bf5a111b35896af2145c133a661a99113",
    "sha256:8fba1f818cc10d521bf1cda8fc0eb8815a4cd572d58ba3359ff59c0197cea6c7"
  ],
  "create-task": [
    "sha256:41459a4575338c4778f0090875fd255c733c41f8bc518a69130100337d2db820",
    "sha256:d70454edba3432c7205a359891dcc5751ceb1d225529f556da6633604718480b"
  ],
  "import-codescan": [
    "sha256:bf3f97fa0bb6cfb1ad875bd0ca27eedc1773480dc7509913a1fa46bc32985311",
    "sha256:1e98dfefd42c87a38768d9d7825370fdeaf375ce0792faf712db13ecd60ca5a0"
  ],
  "import-dependabot": [
    "sha256:9487ab06fbca12b9623234661a2e32b8c497873fcd721b6b7fe21f04c01c2440",
    "sha256:60d95c0d9fd8092240d72ab770e3185dc8ac06e633a527496d148e90e7dd58d9"
  ],
  "import-issue": [
    "sha256:cf463e8b6f3ccf046aae1b1ef2d695ac767f35fe9506dcc6a132f65276f79d1b",
    "sha256:c8496ba3ff8c7e92705715646671ddc20930934d8f4d9f9cbadd7717507f020d"
  ],
  "init-labels": [
    "sha256:97b7f0bb2d77b4ea5074f29c68247c91677d0823f9422f9b063b300d0c5b7da9",
    "sha256:8312873d04e273b63683626664c98601bd5dd6efb6cbe1ae54fff4e1eccb6431"
  ],
  "init-milestones": [
    "sha256:3207118d2b03b4754790b5e5bb5b3a6a6159e1073a8b9663c225fb3ec9122c38",
    "sha256:ff4ebfd5dc1caf9cdd538413f07e290833c8d128e50b2186a57e0eb5f575eaf8"
  ],
  "plan-task": [
    "sha256:581a94bf6bfe4130302f9bf4283f62f9e8de777c32ff3d454da40da6ba05937d",
    "sha256:611be11cef1c7c0ea556f1ff8358fd76b71f756ec0020435dd68f8fd1935355f"
  ],
  "post-release": [
    "sha256:127cc1560083bb2ac9b19ce9bd368de8c8729a8cde6ff1cb4e5af839c6d749b2",
    "sha256:5f7d2022b8f97fc569086776af19254464a74fc9643f2a94febd521508328ebf"
  ],
  "refine-title": [
    "sha256:4e398e907b0661b9636592cba8093a03ae3aa3819846dc899afa668eaa873d47",
    "sha256:8c566c5cbbf91b647a3f448c4e8d1dae872af3deefd595a1f341a2caa0967110"
  ],
  "release": [
    "sha256:8f6e9213ace279d9afd9d3b5b7ec72562d1d6087ffd29d05022f3f694fbd487e",
    "sha256:1c7c2364d4bb42d67e90392030586536f67a993bc6fe372c3a52746a3e4fe634"
  ],
  "restore-task": [
    "sha256:2541f9c2c8963e9f4819b031e6a043508ef36c5be5a4082fa5046d2b711996ff",
    "sha256:8da334cb9733df3e8882248d9e29c2a25f3d8329695ae7d4ad62689c13fa421f"
  ],
  "review-analysis": [
    "sha256:b26ea3c9d0a45c2af8e630ae8081265294122c26ae9da8826579e62a2b80b16e",
    "sha256:bcb7ef14f9ab551adf34f64c60390c195e93775dc1231ac4e066765009ded79d"
  ],
  "review-code": [
    "sha256:315f15afefd01d1a97570dc330ce288528b1fa512916ac596cbd826cb854f11d",
    "sha256:6f7a0114410d7081d04f8d3d35c168892ca83de36d2d5c110cab6c514e412222"
  ],
  "review-plan": [
    "sha256:b281ef14ec9cfc168738390f51ccb56993d1d999d9461bc697ca42988ad215ae",
    "sha256:35d6cceb2f179f34118375431934be69db4a9120a3cafa8b9549c5010c798159"
  ],
  "run-task": [
    "sha256:deb965c69cd8649235b75d2785ad9b25907fb56b9ca2d43b458b84d538cd1f28",
    "sha256:93f78e7a978b073c23a230217242fa8f6ecee9a3ec51db32435852db59733a55"
  ],
  "test-integration": [
    "sha256:33a2a5d207b8251a6343638854f564a827e0d0d9d1ffce9423c4a83f0635354c",
    "sha256:2adf77756cc2283fa104cd2fd73103d586a761602ef1c7d800ea6100146e29fb"
  ],
  "test": [
    "sha256:b2f748f283883402e63a00f3f3e00fcba78f9567d5b6430e52674ab1a9c95c03",
    "sha256:fec975f59c3754820be13bcf89f56c430b940f31997ae48b0b81462ad4a56513"
  ],
  "update-agent-infra": [
    "sha256:40de0e7902d70f7b22b48d8de24fe0b3174a1f0a4596b8a4ab40c6460a129c7f",
    "sha256:d0682c6c7811888b7a9853e389029858a219b13cbc8b8cdfb271b4b159c9fe81"
  ],
  "upgrade-dependency": [
    "sha256:c2f2d46ce308d6ee526dd270408afc380c9a0535f7cbe9dcaa415ef00512a7b5",
    "sha256:828fddc2c9ce19b008986585c72177489bcca72978a97cfeb81e8ed9722adf19"
  ],
  "watch-pr": [
    "sha256:ce04f2b9a905118ed5938ed963efc8e74ae8104b51e711205353d86d7271af7e",
    "sha256:4c686a5f9e350b021e2ce8dbc8020e6342810335e1a920b716fe6c5659b83921"
  ]
};
// Add a new identifier here only after shipping matching .{platform}. template variants.
const KNOWN_PLATFORMS = new Set(['github', 'none']);
const KNOWN_LANGUAGES = new Set(['en', 'zh-CN']);

const BUILTIN_TUI_IDS = AGENT_CLIENT_MANIFEST.map((entry) => entry.id);
const LEGACY_TUI_IDS = { 'gemini-cli': 'antigravity-cli' };
const RETIRED_MANAGED_ASSETS = ['.gemini/commands/'];
const RETIRED_MERGED_ASSETS = ['.gemini/settings.json'];

function normalizeAgentClientConfig(cfg) {
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const diagnostics = [];
  const failure = (code, path) => ({
    source: null,
    state: null,
    canonical: null,
    remainingSandboxTools: undefined,
    removeLegacyTuis: false,
    changed: false,
    diagnostics,
    error: `${code} at ${path}`,
    errorCode: code,
    errorPath: path
  });
  const normalizeClientId = (value) => typeof value === 'string'
    ? (own(LEGACY_TUI_IDS, value)
        ? LEGACY_TUI_IDS[value]
        : (BUILTIN_TUI_IDS.includes(value) ? value : null))
    : null;
  const projectTuis = (value) => {
    if (!Array.isArray(value)) {
      return Object.fromEntries(BUILTIN_TUI_IDS.map((id) => [id, true]));
    }
    const enabled = new Set();
    for (const [index, candidate] of value.entries()) {
      const id = normalizeClientId(candidate);
      if (id) enabled.add(id);
      else diagnostics.push({ code: 'LEGACY_VALUE_IGNORED', path: `tuis[${index}]` });
    }
    return Object.fromEntries(BUILTIN_TUI_IDS.map((id) => [id, enabled.has(id)]));
  };
  const projectSandbox = (value) => {
    if (!Array.isArray(value) || value.length === 0) {
      return {
        installed: Object.fromEntries(BUILTIN_TUI_IDS.map((id) => [id, true])),
        clientSignals: new Set(),
        remainingTools: Array.isArray(value) ? [] : undefined
      };
    }
    const installed = new Set();
    const remainingTools = [];
    for (const [index, candidate] of value.entries()) {
      const id = normalizeClientId(candidate);
      if (id) installed.add(id);
      else if (typeof candidate === 'string') remainingTools.push(candidate);
      else diagnostics.push({ code: 'LEGACY_VALUE_IGNORED', path: `sandbox.tools[${index}]` });
    }
    return {
      installed: Object.fromEntries(BUILTIN_TUI_IDS.map((id) => [id, installed.has(id)])),
      clientSignals: installed,
      remainingTools
    };
  };
  const serialize = (state) => BUILTIN_TUI_IDS.map((id) => ({ id, ...state[id] }));
  const hasCanonical = own(cfg, 'agentClients');
  const hasLegacyTuis = own(cfg, 'tuis');
  const sandbox = cfg.sandbox && typeof cfg.sandbox === 'object' && !Array.isArray(cfg.sandbox)
    ? cfg.sandbox
    : undefined;
  const hasSandboxTools = sandbox !== undefined && own(sandbox, 'tools');
  const tuiProjection = projectTuis(cfg.tuis);
  const sandboxProjection = projectSandbox(sandbox?.tools);

  if (!hasCanonical) {
    const state = Object.fromEntries(BUILTIN_TUI_IDS.map((id) => [id, {
      enabled: tuiProjection[id],
      installInSandbox: sandboxProjection.installed[id]
    }]));
    return {
      source: 'legacy',
      state,
      canonical: serialize(state),
      remainingSandboxTools: sandboxProjection.remainingTools,
      removeLegacyTuis: hasLegacyTuis,
      changed: true,
      diagnostics,
      error: null,
      errorCode: null,
      errorPath: null
    };
  }

  if (!Array.isArray(cfg.agentClients)) return failure('INVALID_AGENT_CLIENTS', 'agentClients');
  const entries = new Map();
  for (const [index, candidate] of cfg.agentClients.entries()) {
    const entryPath = `agentClients[${index}]`;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return failure('INVALID_AGENT_CLIENTS', entryPath);
    }
    const keys = Object.keys(candidate);
    if (
      keys.length !== 3
      || !own(candidate, 'id')
      || !own(candidate, 'enabled')
      || !own(candidate, 'installInSandbox')
    ) {
      return failure('INVALID_AGENT_CLIENTS', entryPath);
    }
    const id = normalizeClientId(candidate.id);
    if (!id) {
      return failure('UNKNOWN_AGENT_CLIENT', `${entryPath}.id`);
    }
    if (entries.has(id)) return failure('DUPLICATE_AGENT_CLIENT', `${entryPath}.id`);
    if (typeof candidate.enabled !== 'boolean' || typeof candidate.installInSandbox !== 'boolean') {
      return failure('INVALID_AGENT_CLIENTS', entryPath);
    }
    entries.set(id, {
      enabled: candidate.enabled,
      installInSandbox: candidate.installInSandbox
    });
  }
  if (BUILTIN_TUI_IDS.some((id) => !entries.has(id))) {
    return failure('MISSING_AGENT_CLIENT', 'agentClients');
  }
  const state = Object.fromEntries(BUILTIN_TUI_IDS.map((id) => [id, entries.get(id)]));
  if (hasLegacyTuis && BUILTIN_TUI_IDS.some((id) => state[id].enabled !== tuiProjection[id])) {
    return failure('LEGACY_CONFLICT', 'tuis');
  }
  if ([...sandboxProjection.clientSignals].some((id) => !state[id].installInSandbox)) {
    return failure('LEGACY_CONFLICT', 'sandbox.tools');
  }
  const sameOrder = cfg.agentClients.every((entry, index) => entry.id === BUILTIN_TUI_IDS[index]);
  return {
    source: 'canonical',
    state,
    canonical: serialize(state),
    remainingSandboxTools: hasSandboxTools ? sandboxProjection.remainingTools : undefined,
    removeLegacyTuis: hasLegacyTuis,
    changed: hasLegacyTuis || sandboxProjection.clientSignals.size > 0 || !sameOrder,
    diagnostics,
    error: null,
    errorCode: null,
    errorPath: null
  };
}

function materializeAgentClientConfig(cfg, normalized) {
  cfg.agentClients = normalized.canonical;
  delete cfg.tuis;
  if (normalized.remainingSandboxTools !== undefined) {
    cfg.sandbox = {
      ...(cfg.sandbox || {}),
      tools: [
        'agent-infra',
        ...normalized.remainingSandboxTools.filter((tool) => tool !== 'agent-infra')
      ]
    };
  }
}

function assetMatches(entry, target) {
  const normalizedEntry = norm(entry);
  const normalizedTarget = norm(target);
  return normalizedEntry.endsWith('/')
    ? normalizedTarget.startsWith(normalizedEntry)
    : normalizedTarget === normalizedEntry;
}

function adapterAssets(adapters, category) {
  return adapters.flatMap((adapter) => adapter[category]);
}

function planProjectRegistry(current, sharedDefaults, enabledSet) {
  const enabledAdapters = AGENT_CLIENT_MANIFEST.filter((adapter) => enabledSet.has(adapter.id));
  const disabledAdapters = AGENT_CLIENT_MANIFEST.filter((adapter) => !enabledSet.has(adapter.id));
  const allAdapterAssets = new Set(
    [...AGENT_CLIENT_MANIFEST.flatMap((adapter) => [
      ...adapter.managed,
      ...adapter.merged,
      ...adapter.ejected
    ]), ...RETIRED_MANAGED_ASSETS, ...RETIRED_MERGED_ASSETS]
  );
  const enabled = {
    managed: adapterAssets(enabledAdapters, 'managed'),
    merged: adapterAssets(enabledAdapters, 'merged'),
    ejected: adapterAssets(enabledAdapters, 'ejected')
  };
  const unique = (values) => [...new Set(values)];
  const ejected = unique([
    ...current.ejected,
    ...enabled.ejected,
    ...sharedDefaults.ejected
  ]);
  const ejectedSet = new Set(ejected);
  const preserve = (values, enabledValues) => values.filter((entry) =>
    !ejectedSet.has(entry)
    && (!allAdapterAssets.has(entry) || enabledValues.includes(entry))
  );
  const managed = unique([
    ...preserve(current.managed, enabled.managed),
    ...enabled.managed.filter((entry) => !ejectedSet.has(entry)),
    ...sharedDefaults.managed.filter((entry) => !ejectedSet.has(entry))
  ]);
  const managedSet = new Set(managed);
  const merged = unique([
    ...preserve(current.merged, enabled.merged),
    ...enabled.merged.filter((entry) => !ejectedSet.has(entry) && !managedSet.has(entry)),
    ...sharedDefaults.merged.filter((entry) => !ejectedSet.has(entry) && !managedSet.has(entry))
  ]);

  return {
    registry: { managed, merged, ejected },
    enabledManaged: enabled.managed,
    enabledMerged: enabled.merged,
    enabledEjected: enabled.ejected,
    disabledManaged: adapterAssets(disabledAdapters, 'managed'),
    retiredManaged: RETIRED_MANAGED_ASSETS
  };
}

function norm(p) { return p.replace(/\\/g, '/'); }

function sha256(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function isRetiredGeminiCommand(target, content, project) {
  const expected = RETIRED_GEMINI_COMMAND_HASHES[path.basename(target, '.toml')];
  if (!expected) return false;
  const normalized = project
    ? content.toString().replaceAll('for ' + project + '.', 'for {' + '{project}}.')
    : content.toString();
  return expected.includes(sha256(normalized));
}

function trustedBaseline(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
}

function normDir(p) {
  return norm(p).replace(/^\.\//, '').replace(/\/+$/, '');
}

function isInsideProject(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '' || path.isAbsolute(relativePath)) {
    return false;
  }

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, relativePath);
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPathOwnedByOtherPlatform(relativePath, platformType) {
  const normalized = norm(relativePath).replace(/^\.\//, '');
  const top = normalized.split('/')[0];
  if (!top.startsWith('.')) return false;

  const candidate = top.slice(1);
  if (!KNOWN_PLATFORMS.has(candidate)) return false;
  return candidate !== platformType;
}

function globMatch(pattern, filePath) {
  const p = norm(pattern), f = norm(filePath);
  const globstarDir = '__GLOBSTAR_DIR__';
  const globstar = '__GLOBSTAR__';
  const star = '__STAR__';
  const qmark = '__QMARK__';
  const re = p
    .replace(/([.+^${}()|[\]\\])/g, '\\$1')
    .replace(/\*\*\//g, globstarDir)
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, star)
    .replace(/\?/g, qmark)
    .replace(new RegExp(globstarDir, 'g'), '(?:.+/)?')
    .replace(new RegExp(globstar, 'g'), '[^/]*')
    .replace(new RegExp(star, 'g'), '[^/]*')
    .replace(new RegExp(qmark, 'g'), '[^/]');
  return new RegExp('^' + re + '$').test(f);
}

function walkDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? out.push(...walkDir(p)) : out.push(p);
  }
  return out;
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  }
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

function resolveVersionFromTemplateRoot(tplRoot) {
  const pkgPath = path.join(path.dirname(tplRoot), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return 'v' + pkg.version;
}

function parseSkillFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const result = {};
  const lines = match[1].split(/\r?\n/);
  const normalizeValue = (value) => value.replace(/^["']|["']$/g, '').trim();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;

    const [, key, rawValue] = pair;
    if (rawValue === '>' || rawValue === '|') {
      const block = [];
      for (let offset = index + 1; offset < lines.length; offset += 1) {
        const nextLine = lines[offset];
        if (!/^\s+/.test(nextLine)) break;

        block.push(nextLine.trim());
        index = offset;
      }
      result[key] = block.join(rawValue === '|' ? '\n' : ' ').trim();
      continue;
    }

    result[key] = normalizeValue(rawValue);
  }

  return result;
}

function listTemplateSkillNames(templateRoot) {
  const templateSkillsDir = path.join(templateRoot, '.agents/skills');
  if (!fs.existsSync(templateSkillsDir)) return new Set();

  return new Set(
    fs.readdirSync(templateSkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        const skillDir = path.join(templateSkillsDir, entry.name);
        return ['SKILL.md', 'SKILL.en.md', 'SKILL.zh-CN.md'].some((file) =>
          fs.existsSync(path.join(skillDir, file))
        );
      })
      .map((entry) => entry.name)
  );
}

function detectCustomSkills(projectRoot, templateSkillNames) {
  const skillsDir = path.join(projectRoot, '.agents/skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !templateSkillNames.has(entry.name))
    .map((entry) => {
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) return null;

      const meta = parseSkillFrontmatter(skillMd);
      return {
        dirName: entry.name,
        name: meta.name || entry.name,
        description: meta.description || '',
        args: meta.args || null,
        disableModelInvocation: meta['disable-model-invocation'] === 'true'
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.dirName.localeCompare(right.dirName));
}

function isCustomProtected(targetPath, customSkills, customTUICommandTargets) {
  const normalized = norm(targetPath);

  return customSkills.some(({ dirName }) => (
    normalized.startsWith(`.agents/skills/${dirName}/`) ||
    normalized === `.claude/commands/${dirName}.md` ||
    normalized === `.opencode/commands/${dirName}.md` ||
    customTUICommandTargets.has(normalized)
  ));
}

function recordCustomTUISkipped(report, entry) {
  report?.custom?.customTUIs?.skipped?.push(entry);
}

function recordCustomTUISkippedRef(report, entry) {
  report?.custom?.customTUIs?.skippedRefs?.push(entry);
}

function expandHome(inputPath) {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

function mergeTemplateSources(baseRoot, sources, report) {
  const sourceMap = new Map();
  const sourceMeta = new Map();
  const conflictsByRel = new Map();
  const baseRels = walkDir(baseRoot).map((filePath) => norm(path.relative(baseRoot, filePath)));

  for (const rel of baseRels) {
    sourceMap.set(rel, baseRoot);
    sourceMeta.set(rel, { type: 'builtin' });
  }

  const recordConflict = (rel, winner, ignored) => {
    const existing = conflictsByRel.get(rel);
    if (existing) {
      existing.winner = winner;
      existing.ignored.push(...ignored);
      return;
    }

    const conflict = { rel, winner, ignored: [...ignored] };
    conflictsByRel.set(rel, conflict);
    report.templateSources.conflicts.push(conflict);
  };

  const templateSources = Array.isArray(sources) ? sources : [];
  for (const [index, source] of templateSources.entries()) {
    if (source?.type !== 'local') continue;
    if (typeof source.path !== 'string' || source.path.trim() === '') {
      report.templateSources.errors.push({
        index,
        type: String(source?.type || ''),
        path: String(source?.path || ''),
        reason: 'invalid path'
      });
      continue;
    }

    const srcDir = expandHome(source.path);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      report.templateSources.errors.push({
        index,
        type: source.type,
        path: source.path,
        reason: 'directory not found'
      });
      continue;
    }

    const extRels = walkDir(srcDir).map((filePath) => norm(path.relative(srcDir, filePath)));
    const sourceInfo = { type: source.type, path: source.path };
    for (const rel of extRels) {
      const existing = sourceMeta.get(rel);
      if (existing?.type === 'builtin') {
        recordConflict(rel, existing, [sourceInfo]);
        continue;
      }

      if (existing) {
        recordConflict(rel, sourceInfo, [existing]);
      }

      sourceMap.set(rel, srcDir);
      sourceMeta.set(rel, sourceInfo);
    }

    report.templateSources.loaded += 1;
    report.templateSources.files += extRels.length;
  }

  return {
    mergedRels: [...sourceMap.keys()],
    sourceMap
  };
}

function writeIfChanged(projectRoot, targetPath, content, reportBucket) {
  const fullPath = path.join(projectRoot, targetPath);
  const exists = fs.existsSync(fullPath);

  if (exists && fs.readFileSync(fullPath, 'utf8') === content) {
    reportBucket.unchanged.push(targetPath);
    return;
  }

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');

  (exists ? reportBucket.updated : reportBucket.generated).push(targetPath);
}

function syncCustomSkillSources(projectRoot, sources, report, templateSkillNames) {
  const skillsDir = path.join(projectRoot, '.agents/skills');
  const syncedSkills = new Map();

  for (const source of sources) {
    if (source?.type !== 'local') continue;
    if (typeof source.path !== 'string' || source.path.trim() === '') {
      report.custom.sourceErrors.push({ source: String(source?.path || ''), reason: 'invalid path' });
      continue;
    }

    const srcDir = expandHome(source.path);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      report.custom.sourceErrors.push({ source: source.path, reason: 'directory not found' });
      continue;
    }

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (templateSkillNames.has(entry.name)) {
        report.custom.sourceErrors.push({
          source: source.path,
          reason: `skill ${entry.name} conflicts with built-in skill`
        });
        continue;
      }

      const skillSrcDir = path.join(srcDir, entry.name);
      const skillMd = path.join(skillSrcDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const skillDstDir = path.join(skillsDir, entry.name);
      const trackedFiles = syncedSkills.get(entry.name) || new Set();
      syncedSkills.set(entry.name, trackedFiles);

      for (const srcFile of walkDir(skillSrcDir)) {
        const relPath = norm(path.relative(skillSrcDir, srcFile));
        const dstFile = path.join(skillDstDir, relPath);
        const projectPath = norm(path.relative(projectRoot, dstFile));
        const srcContent = fs.readFileSync(srcFile);
        const existed = fs.existsSync(dstFile);

        trackedFiles.add(relPath);

        if (existed) {
          const dstContent = fs.readFileSync(dstFile);
          if (srcContent.equals(dstContent)) {
            report.custom.unchanged.push(projectPath);
            continue;
          }
        }

        const dir = path.dirname(dstFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dstFile, srcContent);

        (existed ? report.custom.updated : report.custom.generated).push(projectPath);
      }
    }
  }

  return syncedSkills;
}

function cleanStaleSyncedFiles(projectRoot, syncedSkills, report) {
  const skillsDir = path.join(projectRoot, '.agents/skills');

  for (const [skillName, expectedFiles] of syncedSkills) {
    const skillDir = path.join(skillsDir, skillName);
    if (!fs.existsSync(skillDir)) continue;

    const actualFiles = walkDir(skillDir).map((filePath) => norm(path.relative(skillDir, filePath)));
    const removedBefore = report.custom.removed.length;

    for (const actualFile of actualFiles) {
      if (expectedFiles.has(actualFile)) continue;

      const staleFile = path.join(skillDir, actualFile);
      fs.unlinkSync(staleFile);
      report.custom.removed.push(norm(path.relative(projectRoot, staleFile)));
    }

    if (report.custom.removed.length > removedBefore) {
      removeEmptyDirs(skillDir);
    }
  }
}

function formatYamlMetadata(key, value) {
  if (!value.includes('\n')) {
    return [`${key}: ${JSON.stringify(value)}`];
  }

  return [`${key}: |-`, ...value.split('\n').map((line) => `  ${line}`)];
}

function generateClaudeCommand(skill, lang) {
  const isZhCN = lang === 'zh-CN';
  const lines = ['---', ...formatYamlMetadata('description', skill.description)];

  if (skill.args) {
    lines.push(`usage: ${JSON.stringify(`/${skill.dirName} ${skill.args}`)}`);
  }

  if (skill.disableModelInvocation) {
    lines.push('disable-model-invocation: true');
  }

  lines.push('---', '');
  lines.push(
    isZhCN
      ? `读取并执行 \`.agents/skills/${skill.dirName}/SKILL.md\` 中的 ${skill.dirName} 技能。`
      : `Read and execute the ${skill.dirName} skill from \`.agents/skills/${skill.dirName}/SKILL.md\`.`
  );
  lines.push('');
  lines.push(isZhCN ? '严格按照技能中定义的所有步骤执行。' : 'Follow all steps defined in the skill exactly.');

  return `${lines.join('\n')}\n`;
}

function generateOpenCodeCommand(skill, lang) {
  const isZhCN = lang === 'zh-CN';
  const lines = [
    '---',
    ...formatYamlMetadata('description', skill.description),
    'agent: general',
    'subtask: false',
    '---',
    ''
  ];

  if (skill.args) {
    lines.push(isZhCN ? '参数：$ARGUMENTS' : 'Arguments: $ARGUMENTS');
    lines.push('');
  }

  lines.push(
    isZhCN
      ? `读取并执行 \`.agents/skills/${skill.dirName}/SKILL.md\` 中的 ${skill.dirName} 技能。`
      : `Read and execute the ${skill.dirName} skill from \`.agents/skills/${skill.dirName}/SKILL.md\`.`
  );
  lines.push('');
  lines.push(isZhCN ? '严格按照技能中定义的所有步骤执行。' : 'Follow all steps defined in the skill exactly.');

  return `${lines.join('\n')}\n`;
}

function validateCustomTUIs(projectRoot, customTUIs, report) {
  if (customTUIs === undefined) return [];
  if (!Array.isArray(customTUIs)) {
    recordCustomTUISkipped(report, {
      index: -1,
      name: '',
      dir: '',
      reason: 'customTUIs must be an array'
    });
    return [];
  }
  const tools = customTUIs;
  return tools
    .map((tool, index) => {
      if (
        typeof tool !== 'object'
        || tool === null
        || Array.isArray(tool)
      ) {
        recordCustomTUISkipped(report, {
          index,
          name: '',
          dir: '',
          reason: 'invalid custom TUI'
        });
        return null;
      }

      for (const field of CUSTOM_TUI_CONTRACT.requiredFields) {
        if (
          typeof tool[field] !== 'string'
          || tool[field].trim() === ''
          || /[\r\n]/.test(tool[field])
        ) {
          recordCustomTUISkipped(report, {
            index,
            name: String(tool.name || ''),
            dir: String(tool.dir || ''),
            reason: `invalid ${field}`
          });
          return null;
        }
      }

      if (typeof tool?.dir !== 'string' || tool.dir.trim() === '') {
        recordCustomTUISkipped(report, {
          index,
          name: String(tool?.name || ''),
          dir: String(tool?.dir || ''),
          reason: 'invalid dir'
        });
        return null;
      }

      if (tool.dir.includes('\\')) {
        recordCustomTUISkipped(report, {
          index,
          name: tool.name,
          dir: tool.dir,
          reason: 'dir must use POSIX separators'
        });
        return null;
      }

      if (!isInsideProject(projectRoot, tool.dir)) {
        recordCustomTUISkipped(report, {
          index,
          name: String(tool?.name || ''),
          dir: tool.dir,
          reason: 'dir must be a relative path inside the project root'
        });
        return null;
      }

      const placeholders = [...tool.invoke.matchAll(/\$\{([^}]+)\}/g)]
        .map((match) => match[1]);
      if (
        !placeholders.includes('skillName')
        || placeholders.some((placeholder) =>
          !CUSTOM_TUI_CONTRACT.allowedPlaceholders.includes(placeholder)
        )
        || tool.invoke
          .replaceAll('${skillName}', '')
          .replaceAll('${projectName}', '')
          .includes('${')
      ) {
        recordCustomTUISkipped(report, {
          index,
          name: tool.name,
          dir: tool.dir,
          reason: 'invalid invoke placeholders'
        });
        return null;
      }

      return { ...tool, index, dir: normDir(tool.dir) };
    })
    .filter(Boolean);
}

function customTUITargetPath(tool, refFile, refSkillName, skillName) {
  const targetFile = refFile.includes(refSkillName)
    ? refFile.replaceAll(refSkillName, skillName)
    : `${skillName}${path.extname(refFile)}`;
  return norm(path.join(tool.dir, targetFile));
}

function findCustomTUIReference(projectRoot, tool, templateSkillNames, report, logSkipped = false) {
  const cmdDir = path.join(projectRoot, tool.dir);
  if (!fs.existsSync(cmdDir) || !fs.statSync(cmdDir).isDirectory()) {
    if (logSkipped) {
      recordCustomTUISkipped(report, {
        index: tool.index,
        name: String(tool.name || ''),
        dir: tool.dir,
        reason: 'directory not found'
      });
    }
    return null;
  }

  const cmdFiles = fs.readdirSync(cmdDir)
    .filter((file) => fs.statSync(path.join(cmdDir, file)).isFile())
    .sort((left, right) => left.localeCompare(right));
  if (cmdFiles.length === 0) {
    if (logSkipped) {
      recordCustomTUISkipped(report, {
        index: tool.index,
        name: String(tool.name || ''),
        dir: tool.dir,
        reason: 'no command files'
      });
    }
    return null;
  }

  let sawKnownSkillReference = false;

  for (const file of cmdFiles) {
    const content = fs.readFileSync(path.join(cmdDir, file), 'utf8');
    const match = content.match(/\.agents\/skills\/([^/]+)\/SKILL\.md/);
    if (!match) continue;

    const skillName = match[1];
    if (!templateSkillNames.has(skillName)) continue;

    const skillMd = path.join(projectRoot, '.agents/skills', skillName, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    const meta = parseSkillFrontmatter(skillMd);
    if (!meta.description) continue;

    sawKnownSkillReference = true;
    if (!content.includes(meta.description)) {
      if (logSkipped) {
        recordCustomTUISkippedRef(report, {
          index: tool.index,
          name: String(tool.name || ''),
          dir: tool.dir,
          file,
          skill: skillName,
          reason: 'description not found in reference command file'
        });
      }
      continue;
    }

    return { content, file, skillName, skillDesc: meta.description };
  }

  if (logSkipped) {
    recordCustomTUISkipped(report, {
      index: tool.index,
      name: String(tool.name || ''),
      dir: tool.dir,
      reason: sawKnownSkillReference
        ? 'no reference command file with matching description'
        : 'no usable reference command file'
    });
  }

  return null;
}

function buildCustomTUICommandTargets(projectRoot, customSkills, customTUIs, templateSkillNames) {
  const targets = new Set();
  for (const tool of customTUIs) {
    const ref = findCustomTUIReference(projectRoot, tool, templateSkillNames, null, false);
    if (!ref) continue;

    for (const skill of customSkills) {
      targets.add(customTUITargetPath(tool, ref.file, ref.skillName, skill.dirName));
    }
  }

  return targets;
}

function learnAndGenerateCommands(projectRoot, customSkills, tool, templateSkillNames, report) {
  const ref = findCustomTUIReference(projectRoot, tool, templateSkillNames, report, true);
  if (!ref) return;

  for (const skill of customSkills) {
    const descToken = '__AGENT_INFRA_CUSTOM_SKILL_DESCRIPTION__';
    const generated = ref.content
      .replaceAll(ref.skillDesc, descToken)
      .replaceAll(ref.skillName, skill.dirName)
      .replaceAll(descToken, skill.description);

    writeIfChanged(
      projectRoot,
      customTUITargetPath(tool, ref.file, ref.skillName, skill.dirName),
      generated,
      report.custom.commands
    );
  }
}

function generateCustomCommands(
  projectRoot,
  customSkills,
  lang,
  report,
  customTUIs,
  templateSkillNames,
  enabledTUIs,
  managedWriter
) {
  for (const skill of customSkills) {
    if (enabledTUIs.has('claude-code')) {
      managedWriter(
        `.claude/commands/${skill.dirName}.md`,
        generateClaudeCommand(skill, lang),
        report.custom.commands
      );
    }
    if (enabledTUIs.has('opencode')) {
      managedWriter(
        `.opencode/commands/${skill.dirName}.md`,
        generateOpenCodeCommand(skill, lang),
        report.custom.commands
      );
    }
  }

  const tools = Array.isArray(customTUIs) ? customTUIs : [];
  for (const tool of tools) {
    learnAndGenerateCommands(projectRoot, customSkills, tool, templateSkillNames, report);
  }
}

function matchesAny(rel, patterns) {
  const n = norm(rel);
  return patterns.some(p => norm(p) === n || globMatch(p, n));
}

function renderContent(text, vars) {
  return text
    .replace(/\{\{project\}\}/g, vars.project)
    .replace(/\{\{org\}\}/g, vars.org);
}

function renderPathname(p, project) {
  return p.replace(/_project_/g, project);
}

function variantExt(relativePath) {
  return path.extname(relativePath);
}

function variantBase(relativePath) {
  const ext = variantExt(relativePath);
  return relativePath.slice(0, -ext.length);
}

function withVariant(relativePath, variant) {
  const ext = variantExt(relativePath);
  const base = variantBase(relativePath);
  return `${base}.${variant}${ext}`;
}

function stripVariant(relativePath, variant) {
  return relativePath.replace(new RegExp(`\\.${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), '.');
}

function isPlatformVariant(relativePath, platform) {
  const platforms = new Set([...KNOWN_PLATFORMS, platform]);
  for (const candidate of platforms) {
    if (relativePath.includes(`.${candidate}.`)) {
      return true;
    }
  }
  return false;
}

function isLangVariant(relativePath) {
  for (const lang of KNOWN_LANGUAGES) {
    if (relativePath.includes(`.${lang}.`)) {
      return true;
    }
  }
  return false;
}

function stripLangVariant(relativePath) {
  for (const lang of KNOWN_LANGUAGES) {
    if (relativePath.includes(`.${lang}.`)) {
      return stripVariant(relativePath, lang);
    }
  }
  return relativePath;
}

function isBinary(fp) {
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(8192);
  const n = fs.readSync(fd, buf, 0, 8192, 0);
  fs.closeSync(fd);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function langSelect(rels, lang, allSet, project) {
  const sel = new Map();

  for (const r of rels) {
    if (r.includes(`.${lang}.`)) {
      const target = norm(renderPathname(stripVariant(r, lang), project));
      sel.set(target, r);
    } else if (!isLangVariant(r)) {
      const target = norm(renderPathname(r, project));
      if (!sel.has(target)) {
        sel.set(target, r);
      }
    }
  }

  return sel;
}

function platformSelect(entries, platform, project) {
  const sel = new Map();

  for (const [target, src] of entries) {
    if (!target.includes(`.${platform}.`)) continue;
    sel.set(norm(renderPathname(stripVariant(target, platform), project)), src);
  }

  for (const [target, src] of entries) {
    const normalizedTarget = norm(renderPathname(target, project));
    if (sel.has(normalizedTarget)) continue;
    if (isPlatformVariant(target, platform)) continue;
    sel.set(normalizedTarget, src);
  }

  return sel;
}

function entryVariantRels(entry, allSet, platform) {
  const rels = [];
  const normalized = norm(entry);
  const candidates = [
    normalized,
    withVariant(normalized, 'en'),
    withVariant(normalized, 'zh-CN'),
    withVariant(normalized, platform),
    withVariant(withVariant(normalized, platform), 'en'),
    withVariant(withVariant(normalized, platform), 'zh-CN')
  ];

  for (const candidate of candidates) {
    if (allSet.has(candidate) && !rels.includes(candidate)) {
      rels.push(candidate);
    }
  }

  return rels;
}

function syncTemplates(projectRoot, templateRootOverride) {
  const configDir = path.join(projectRoot, '.agents');
  const cfgPath = path.join(configDir, '.airc.json');

  if (!fs.existsSync(cfgPath)) {
    return { error: 'No .agents/.airc.json in project root.' };
  }

  const originalConfigText = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(originalConfigText);
  const configPathRel = norm(path.relative(projectRoot, cfgPath));
  let templateRoot = templateRootOverride;
  if (!templateRoot) {
    const packageResolution = resolveAgentInfraPackage({
      startPath: path.join(projectRoot, '.agents', 'scripts', 'lib', 'agent-infra-package.js')
    });
    if (packageResolution.templateRoot && fs.existsSync(packageResolution.templateRoot)) {
      templateRoot = packageResolution.templateRoot;
    } else {
      return {
        error: formatAgentInfraPackageError(packageResolution)
      };
    }
  }
  const version = resolveVersionFromTemplateRoot(templateRoot);

  const { project, org, language: lang = 'en' } = cfg;
  const platformType = cfg.platform?.type || DEFAULTS.platform.type;
  const enabledResolution = normalizeAgentClientConfig(cfg);
  if (enabledResolution.error) {
    return { error: enabledResolution.error };
  }
  const enabledTUIs = new Set(
    BUILTIN_TUI_IDS.filter((id) => enabledResolution.state[id].enabled)
  );
  materializeAgentClientConfig(cfg, enabledResolution);
  const customTUIsConfig = Array.isArray(cfg.customTUIs) ? cfg.customTUIs : [];
  const vars = { project, org };
  const templateSkillNames = listTemplateSkillNames(templateRoot);
  const protectedCustomSkills = detectCustomSkills(projectRoot, templateSkillNames);

  cfg.files ||= {};
  const currentRegistry = {
    managed: [...(cfg.files.managed || [])],
    merged: [...(cfg.files.merged || [])],
    ejected: [...(cfg.files.ejected || [])]
  };
  const sharedDefaults = {
    managed: (DEFAULTS.files.managed || []).filter(
      (entry) => !isPathOwnedByOtherPlatform(entry, platformType)
    ),
    merged: (DEFAULTS.files.merged || []).filter(
      (entry) => !isPathOwnedByOtherPlatform(entry, platformType)
    ),
    ejected: [...(DEFAULTS.files.ejected || [])]
  };
  const assetPlan = planProjectRegistry(currentRegistry, sharedDefaults, enabledTUIs);
  const managed = [...assetPlan.registry.managed];
  const merged = [...assetPlan.registry.merged];
  const ejected = [...assetPlan.registry.ejected];
  const guardedManaged = new Set((DEFAULTS.files.guardedManaged || []).map(norm));
  const allClientManaged = adapterAssets(AGENT_CLIENT_MANIFEST, 'managed');
  const managedBaselines = cfg.files.managedBaselines && typeof cfg.files.managedBaselines === 'object'
    && !Array.isArray(cfg.files.managedBaselines)
    ? { ...cfg.files.managedBaselines }
    : {};
  let baselinesChanged = false;

  for (const target of Object.keys(managedBaselines)) {
    if (
      !guardedManaged.has(norm(target))
      && ![...allClientManaged, ...assetPlan.retiredManaged]
        .some((entry) => assetMatches(entry, target))
    ) {
      delete managedBaselines[target];
      baselinesChanged = true;
    }
  }

  const report = {
    templateVersion: version,
    templateRoot: norm(templateRoot),
    registryAdded: [],
    registryRemoved: [],
    templateSources: {
      configured: 0,
      loaded: 0,
      files: 0,
      errors: [],
      conflicts: []
    },
    managed: {
      written: [],
      created: [],
      unchanged: [],
      protected: [],
      conflicts: [],
      skippedMerged: [],
      skippedPlatform: [],
      skippedTUI: [],
      removed: []
    },
    custom: {
      detected: [],
      generated: [],
      updated: [],
      unchanged: [],
      removed: [],
      sourceErrors: [],
      customTUIs: { skipped: [], skippedRefs: [] },
      commands: { generated: [], updated: [], unchanged: [] }
    },
    ejected: { created: [], skipped: [] },
    merged:  { pending: [] },
    configUpdated: false
  };
  const customTUIs = validateCustomTUIs(projectRoot, customTUIsConfig, report);
  const customTUICommandTargets = buildCustomTUICommandTargets(
    projectRoot,
    protectedCustomSkills,
    customTUIs,
    templateSkillNames
  );

  for (const category of ['managed', 'merged', 'ejected']) {
    const before = currentRegistry[category];
    const after = assetPlan.registry[category];
    for (const entry of after) {
      if (!before.includes(entry)) report.registryAdded.push({ entry, list: category });
    }
    for (const entry of before) {
      if (!after.includes(entry)) report.registryRemoved.push({ entry, list: category });
    }
  }
  report.managed.skippedTUI.push(
    ...assetPlan.disabledManaged,
    ...adapterAssets(
      AGENT_CLIENT_MANIFEST.filter((adapter) => !enabledTUIs.has(adapter.id)),
      'merged'
    )
  );

  const templateSources = Array.isArray(cfg.templates?.sources) ? cfg.templates.sources : [];
  report.templateSources.configured = templateSources.length;
  const { mergedRels, sourceMap } = mergeTemplateSources(templateRoot, templateSources, report);
  const allRels = mergedRels;
  const allSet = new Set(allRels);

  function renderedTemplate(entry) {
    const target = norm(renderPathname(entry, project));
    const selected = platformSelect(
      langSelect(entryVariantRels(entry, allSet, platformType), lang, allSet, project),
      platformType,
      project
    );
    const src = selected.get(target);
    if (!src) return null;
    const srcRoot = sourceMap.get(src) || templateRoot;
    const srcFull = path.join(srcRoot, src);
    return isBinary(srcFull)
      ? fs.readFileSync(srcFull)
      : renderContent(fs.readFileSync(srcFull, 'utf8'), vars);
  }

  function selectedTargetsForEntry(entry) {
    let entryRels;
    if (entry.endsWith('/')) {
      const builtinDir = path.join(templateRoot, entry);
      const builtinRels = fs.existsSync(builtinDir)
        ? walkDir(builtinDir).map((filePath) => norm(path.relative(templateRoot, filePath)))
        : [];
      const prefix = norm(entry);
      const externalRels = allRels.filter((rel) =>
        rel.startsWith(prefix) && !builtinRels.includes(rel)
      );
      entryRels = [...builtinRels, ...externalRels];
    } else {
      entryRels = entryVariantRels(entry, allSet, platformType);
    }
    return platformSelect(
      langSelect(entryRels, lang, allSet, project),
      platformType,
      project
    );
  }

  function writeProtectedManaged(target, content, bucket) {
    const dstFull = path.join(projectRoot, target);
    const exists = fs.existsSync(dstFull);
    const rawBaseline = managedBaselines[target];
    const baseline = trustedBaseline(rawBaseline);
    const templateHash = sha256(content);
    const localHash = exists ? sha256(fs.readFileSync(dstFull)) : null;

    if (rawBaseline !== undefined && baseline === null) {
      delete managedBaselines[target];
      baselinesChanged = true;
    }
    if (baseline === null && localHash !== null && localHash !== templateHash) {
      report.managed.conflicts.push({
        target,
        reason: 'unknown-origin',
        baseline: null,
        local: localHash,
        template: templateHash
      });
      return false;
    }
    if (baseline !== null && templateHash === baseline && localHash !== baseline) {
      report.managed.protected.push({
        target,
        reason: localHash === null ? 'user-deleted' : 'user-modified',
        baseline,
        local: localHash,
        template: templateHash
      });
      return false;
    }
    if (
      baseline !== null
      && localHash !== baseline
      && templateHash !== baseline
      && localHash !== templateHash
    ) {
      report.managed.conflicts.push({
        target,
        reason: 'both-modified',
        baseline,
        local: localHash,
        template: templateHash
      });
      return false;
    }
    if (localHash === templateHash) {
      bucket.unchanged.push(target);
      if (managedBaselines[target] !== templateHash) {
        managedBaselines[target] = templateHash;
        baselinesChanged = true;
      }
      return false;
    }

    const dir = path.dirname(dstFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dstFull, content);
    managedBaselines[target] = templateHash;
    baselinesChanged = true;
    if (Object.prototype.hasOwnProperty.call(bucket, 'written')) {
      (exists ? bucket.written : bucket.created).push(target);
    } else {
      (exists ? bucket.updated : bucket.generated).push(target);
    }
    return true;
  }

  for (const entry of [...managed, ...merged, ...ejected]) {
    if (!isPathOwnedByOtherPlatform(entry, platformType)) continue;

    if (entry.endsWith('/')) {
      const dir = path.join(projectRoot, entry);
      if (!fs.existsSync(dir)) continue;

      for (const filePath of walkDir(dir)) {
        const relativeFile = norm(path.relative(projectRoot, filePath));
        if (guardedManaged.has(relativeFile)) continue;
        fs.unlinkSync(filePath);
        report.managed.removed.push(relativeFile);
      }
      removeEmptyDirs(dir);
      continue;
    }

    const renderedTarget = norm(renderPathname(entry, project));
    const target = path.join(projectRoot, renderedTarget);
    if (!guardedManaged.has(renderedTarget)) {
      if (!fs.existsSync(target)) continue;
      fs.unlinkSync(target);
      report.managed.removed.push(renderedTarget);
      continue;
    }

    const baseline = trustedBaseline(managedBaselines[renderedTarget]);
    const templateContent = renderedTemplate(entry);
    const templateHash = templateContent === null ? null : sha256(templateContent);
    const localHash = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : null;
    const safeToRemove = localHash !== null && (localHash === baseline || (!baseline && localHash === templateHash));

    if (safeToRemove) {
      fs.unlinkSync(target);
      report.managed.removed.push(renderedTarget);
      if (Object.prototype.hasOwnProperty.call(managedBaselines, renderedTarget)) {
        delete managedBaselines[renderedTarget];
        baselinesChanged = true;
      }
      continue;
    }

    if (localHash !== null || baseline !== null) {
      report.managed.conflicts.push({
        target: renderedTarget,
        reason: localHash === null ? 'platform-switch-deleted' : 'platform-switch-modified',
        baseline,
        local: localHash,
        template: templateHash
      });
    }
  }

  // Disabled clients are converged conservatively: only exact manifest
  // managed targets or previously baselined generated targets are candidates.
  // Merged/ejected and content without trustworthy origin evidence are kept.
  for (const entry of [...assetPlan.disabledManaged, ...assetPlan.retiredManaged]) {
    const retired = assetPlan.retiredManaged.includes(entry);
    const selectedTargets = selectedTargetsForEntry(entry);
    const candidates = new Set(
      Object.keys(managedBaselines).filter((target) => assetMatches(entry, target))
    );
    for (const target of selectedTargets.keys()) candidates.add(target);
    if (retired) {
      const retiredRoot = path.join(projectRoot, entry);
      if (fs.existsSync(retiredRoot) && fs.statSync(retiredRoot).isDirectory()) {
        for (const filePath of walkDir(retiredRoot)) {
          candidates.add(norm(path.relative(projectRoot, filePath)));
        }
      }
    }

    for (const target of candidates) {
      const dstFull = path.join(projectRoot, target);
      const baseline = trustedBaseline(managedBaselines[target]);
      const selectedSource = selectedTargets.get(target);
      const sourceRoot = selectedSource ? (sourceMap.get(selectedSource) || templateRoot) : null;
      const templateContent = selectedSource && sourceRoot === templateRoot
        ? (
            isBinary(path.join(sourceRoot, selectedSource))
              ? fs.readFileSync(path.join(sourceRoot, selectedSource))
              : renderContent(fs.readFileSync(path.join(sourceRoot, selectedSource), 'utf8'), vars)
          )
        : null;
      const localHash = fs.existsSync(dstFull) ? sha256(fs.readFileSync(dstFull)) : null;
      const templateHash = templateContent === null ? null : sha256(templateContent);
      const protectedByEjection = ejected.some((pattern) =>
        assetMatches(pattern, target) || globMatch(pattern, target)
      );
      const protectedByCustom = customTUICommandTargets.has(target);

      if (protectedByEjection || protectedByCustom || (sourceRoot && sourceRoot !== templateRoot)) {
        report.managed.protected.push({
          target,
          reason: protectedByEjection
            ? 'ejected'
            : protectedByCustom
              ? 'custom'
              : 'external-source',
          baseline,
          local: localHash,
          template: templateHash
        });
        continue;
      }
      if (localHash === null) {
        if (Object.prototype.hasOwnProperty.call(managedBaselines, target)) {
          delete managedBaselines[target];
          baselinesChanged = true;
        }
        continue;
      }
      const legacyManaged = currentRegistry.managed.includes(entry);
      if (
        (baseline !== null && localHash === baseline)
        || (baseline === null && legacyManaged && templateHash !== null && localHash === templateHash)
        || (baseline === null && retired && legacyManaged
          && isRetiredGeminiCommand(target, fs.readFileSync(dstFull), String(project || '')))
      ) {
        fs.unlinkSync(dstFull);
        report.managed.removed.push(target);
        if (Object.prototype.hasOwnProperty.call(managedBaselines, target)) {
          delete managedBaselines[target];
          baselinesChanged = true;
        }
        removeEmptyDirs(path.dirname(dstFull));
        continue;
      }
      report.managed.protected.push({
        target,
        reason: baseline === null ? 'unknown-origin' : 'user-modified',
        baseline,
        local: localHash,
        template: templateHash
      });
    }
    if (entry.endsWith('/')) {
      removeEmptyDirs(path.join(projectRoot, entry));
    }
  }

  for (const entry of managed) {
    if (isPathOwnedByOtherPlatform(entry, platformType)) {
      report.managed.skippedPlatform.push(entry);
      continue;
    }
    const isDir = entry.endsWith('/');
    let entryRels;
    const expectedTargets = isDir ? new Set() : null;

    if (isDir) {
      const dir = path.join(templateRoot, entry);
      const builtinRels = fs.existsSync(dir)
        ? walkDir(dir).map((filePath) => norm(path.relative(templateRoot, filePath)))
        : [];
      const prefix = norm(entry);
      const externalRels = allRels.filter((rel) => rel.startsWith(prefix) && !builtinRels.includes(rel));
      entryRels = [...builtinRels, ...externalRels];
      if (!entryRels.length) continue;
    } else {
      entryRels = entryVariantRels(entry, allSet, platformType);
      if (!entryRels.length) continue;
    }

    const selected = platformSelect(langSelect(entryRels, lang, allSet, project), platformType, project);

    for (const [tgt, src] of selected) {
      if (expectedTargets) expectedTargets.add(tgt);

      if (matchesAny(tgt, merged) || matchesAny(tgt, ejected)) {
        report.managed.skippedMerged.push(tgt);
        continue;
      }

      const srcRoot = sourceMap.get(src) || templateRoot;
      const srcFull = path.join(srcRoot, src);
      const dstFull = path.join(projectRoot, tgt);
      const bin = isBinary(srcFull);
      const content = bin
        ? fs.readFileSync(srcFull)
        : renderContent(fs.readFileSync(srcFull, 'utf8'), vars);

      const exists = fs.existsSync(dstFull);
      const clientManagedTarget = assetPlan.enabledManaged.some((asset) =>
        assetMatches(asset, tgt)
      );
      if (guardedManaged.has(tgt) || (clientManagedTarget && srcRoot === templateRoot)) {
        const written = writeProtectedManaged(tgt, content, report.managed);
        if (written && tgt.endsWith('.sh')) {
          try { fs.chmodSync(dstFull, 0o755); } catch { /* Windows */ }
        }
        continue;
      }

      if (exists) {
        const cur = bin ? fs.readFileSync(dstFull) : fs.readFileSync(dstFull, 'utf8');
        if (bin ? content.equals(cur) : content === cur) {
          report.managed.unchanged.push(tgt);
          continue;
        }
      }

      const dir = path.dirname(dstFull);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dstFull, content);
      if (tgt.endsWith('.sh')) {
        try { fs.chmodSync(dstFull, 0o755); } catch { /* Windows */ }
      }

      (exists ? report.managed.written : report.managed.created).push(tgt);
    }

    if (isDir) {
      const projDir = path.join(projectRoot, entry);
      if (fs.existsSync(projDir)) {
        const removedBefore = report.managed.removed.length;
        const projFiles = walkDir(projDir).map(f => norm(path.relative(projectRoot, f)));
        for (const projFile of projFiles) {
          if (expectedTargets.has(projFile)) continue;
          if (projFile === configPathRel) continue;
          if (isCustomProtected(projFile, protectedCustomSkills, customTUICommandTargets)) continue;
          if (matchesAny(projFile, merged) || matchesAny(projFile, ejected)) continue;
          if (assetPlan.enabledManaged.includes(entry)) {
            const baseline = trustedBaseline(managedBaselines[projFile]);
            const localHash = sha256(fs.readFileSync(path.join(projectRoot, projFile)));
            if (baseline !== null && localHash === baseline) {
              fs.unlinkSync(path.join(projectRoot, projFile));
              delete managedBaselines[projFile];
              baselinesChanged = true;
              report.managed.removed.push(projFile);
            } else {
              report.managed.protected.push({
                target: projFile,
                reason: baseline === null ? 'unknown-origin' : 'user-modified',
                baseline,
                local: localHash,
                template: null
              });
            }
            continue;
          }
          fs.unlinkSync(path.join(projectRoot, projFile));
          report.managed.removed.push(projFile);
        }
        if (report.managed.removed.length > removedBefore) {
          removeEmptyDirs(projDir);
        }
      }
    }
  }

  const sources = Array.isArray(cfg.skills?.sources) ? cfg.skills.sources : [];
  if (sources.length > 0) {
    const syncedSkills = syncCustomSkillSources(projectRoot, sources, report, templateSkillNames);
    cleanStaleSyncedFiles(projectRoot, syncedSkills, report);
  }

  const customSkills = detectCustomSkills(projectRoot, templateSkillNames);
  report.custom.detected = customSkills.map((skill) => skill.dirName);
  generateCustomCommands(
    projectRoot,
    customSkills,
    lang,
    report,
    customTUIs,
    templateSkillNames,
    enabledTUIs,
    writeProtectedManaged
  );

  for (const entry of ejected) {
    const dstFull = path.join(projectRoot, entry);
    if (fs.existsSync(dstFull)) {
      report.ejected.skipped.push(entry);
      continue;
    }
    // Do not (re)create ejected files for disabled TUIs. Existing files are
    // never touched by sync (handled above); this guard only blocks creation.
    const disabledEjected = AGENT_CLIENT_MANIFEST.some((adapter) =>
      !enabledTUIs.has(adapter.id)
      && adapter.ejected.some((asset) => assetMatches(asset, entry))
    );
    if (disabledEjected) continue;

    const selected = platformSelect(langSelect(entryVariantRels(entry, allSet, platformType), lang, allSet, project), platformType, project);
    const target = norm(renderPathname(entry, project));
    const src = selected.get(target);
    if (!src) continue;

    const srcRoot = sourceMap.get(src) || templateRoot;
    const content = renderContent(fs.readFileSync(path.join(srcRoot, src), 'utf8'), vars);
    const dir = path.dirname(dstFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dstFull, content);
    report.ejected.created.push(entry);
  }

  const mergedMap = new Map();
  for (const entry of merged) {
    if (isPathOwnedByOtherPlatform(entry, platformType)) {
      report.managed.skippedPlatform.push(entry);
      continue;
    }
    if (entry.includes('*')) {
      const hits = allRels.filter(r => {
        const t = norm(renderPathname(stripLangVariant(r), project));
        return globMatch(entry, t);
      });
      for (const [t, s] of platformSelect(langSelect(hits, lang, allSet, project), platformType, project)) {
        if (!mergedMap.has(t)) mergedMap.set(t, s);
      }
    } else {
      const rels = entryVariantRels(entry, allSet, platformType);
      const selected = platformSelect(langSelect(rels, lang, allSet, project), platformType, project);
      for (const [t, s] of selected) {
        if (!mergedMap.has(t)) mergedMap.set(t, s);
      }
    }
  }
  report.merged.pending = [...mergedMap].map(
    ([target, template]) => ({ target, template })
  );

  cfg.files.managed = managed;
  cfg.files.merged  = merged;
  cfg.files.ejected = ejected;
  if (Object.keys(managedBaselines).length > 0) {
    cfg.files.managedBaselines = managedBaselines;
  } else {
    if (Object.prototype.hasOwnProperty.call(cfg.files, 'managedBaselines')) baselinesChanged = true;
    delete cfg.files.managedBaselines;
  }
  cfg.templateVersion = version;
  delete cfg.templateSource;

  const nextConfigText = JSON.stringify(cfg, null, 2) + '\n';
  report.configUpdated = originalConfigText !== nextConfigText;
  if (report.configUpdated) {
    const temporary = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, nextConfigText, 'utf8');
      fs.renameSync(temporary, cfgPath);
    } catch (error) {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {
        // Preserve the original write/rename failure.
      }
      throw error;
    }
  }

  return report;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || process.cwd());
  const result = syncTemplates(root);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.error) process.exitCode = 1;
}

export { normalizeAgentClientConfig, syncTemplates };
