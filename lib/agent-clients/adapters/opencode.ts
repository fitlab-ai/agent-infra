import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';

const YOLO_PERMISSION = '{"*":"allow","read":"allow","bash":"allow","edit":"allow","webfetch":"allow","external_directory":"allow","doom_loop":"allow"}';

const opencodeAdapter = defineAgentClientAdapter({
  id: 'opencode',
  displayName: 'OpenCode',
  invocation: '/${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'compatible' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  project: {
    ownedPathPrefixes: ['.opencode/'],
    managed: ['.opencode/commands/'],
    merged: [],
    ejected: []
  },
  sandbox: {
    createTool: ({ home }) => ({
      id: 'opencode',
      name: 'OpenCode',
      install: { type: 'npm', cmd: 'opencode-ai' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'opencode'),
      containerMount: '/home/devuser/.local/share/opencode',
      versionCmd: 'opencode version',
      setupHint: 'Configure OpenCode credentials inside the container before first use.',
      envVars: {
        OPENCODE_CONFIG: '/home/devuser/.local/share/opencode/opencode.json'
      },
      hostLiveMounts: [
        {
          hostPath: hostJoin(home, '.local', 'share', 'opencode', 'auth.json'),
          containerSubpath: 'auth.json'
        }
      ]
    }),
    aliases: [
      {
        name: 'opencode-yolo',
        command: `OPENCODE_PERMISSION='${YOLO_PERMISSION}' opencode; tput ed`
      },
      {
        name: 'oy',
        command: `OPENCODE_PERMISSION='${YOLO_PERMISSION}' opencode; tput ed`
      }
    ],
    hooks: []
  }
});

export { opencodeAdapter };
