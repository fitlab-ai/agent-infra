export const PUBLIC_CLI_COMMAND_ALIASES = Object.freeze({
  '': 'help',
  s: 'sandbox',
  t: 'task',
  '--version': 'version',
  '-v': 'version'
} as const);

export const PUBLIC_CLI_SELECTOR_ALIASES = Object.freeze({
  task: Object.freeze({ d: 'decisions' })
} as const);

export const PUBLIC_CLI_ROUTE_SELECTORS = Object.freeze({
  'agent-client': ['list', 'status', 'enable', 'disable', 'configure'],
  cp: ['cp'],
  data: ['capture', 'verify', 'audit', 'repair', 'export'],
  decide: ['decide'],
  help: ['help'],
  init: ['init'],
  merge: ['merge'],
  run: ['create-task', 'task-skill', 'recreate'],
  sandbox: ['create', 'exec', 'ls', 'show', 'prune', 'rebuild', 'refresh', 'rm', 'start', 'vm'],
  server: ['start', 'stop', 'status', 'logs', '__daemon'],
  task: ['cat', 'decisions', 'files', 'grep', 'issue-body', 'log', 'ls', 'show', 'status'],
  sync: ['sync'],
  update: ['update'],
  version: ['version']
} as const);

export const INTERNAL_CLI_ROUTE_SELECTORS = Object.freeze({
  'task-create': ['input'],
  'sandbox-control': ['serve', 'execute', 'recover', 'client'],
  'agent-client': ['next-steps', 'model-selection'],
  'codex-lifecycle': ['preflight', 'capability-arm', 'hook-event', 'resolve-start', 'resolve-stop', 'consume'],
  'codex-sandbox-controller': ['verify-context', 'run'],
  'git-workflow': ['inspect', 'preview-tree', 'snapshot', 'compare-trees', 'commit', 'push-rebased'],
  'task-delivery': ['deliver'],
  'release-workflow': ['inspect', 'prepare', 'publish', 'post-prepare', 'post-publish'],
  'platform-release-notes': ['context', 'stage', 'publish'],
  'platform-context': ['resolve'],
  'platform-comment': ['list', 'owner', 'backfill', 'sync'],
  'platform-issue': ['inspect', 'create', 'bind', 'sync'],
  'platform-pr': ['inspect', 'summary-context', 'resolve-external', 'create', 'bind', 'skip', 'sync', 'change-report', 'summary-sync', 'sync-in-labels'],
  'platform-pr-review': ['inspect', 'list', 'publish-pr', 'publish-task'],
  'pr-review-grade': ['decide', 'resolve-host', 'verify-artifact'],
  'platform-checks': ['inspect', 'watch', 'resolve-run', 'logs'],
  'task-context': ['resolve'],
  'task-ledger': ['decision-next-id', 'stage-status', 'finding-upsert', 'finding-respond', 'finding-review', 'decision-upsert', 'rework-intent-upsert'],
  'task-warning': ['list', 'add', 'set-status'],
  'task-activity': ['pr-review-inspect', 'pr-review-start', 'pr-review-complete', 'pr-review-terminate'],
  'task-artifact': ['inspect', 'finalize-local'],
  'task-orchestration': ['status', 'progress'],
  'task-review': ['finalize-summary'],
  'task-event': ['event'],
  'task-invalidation': ['reconcile'],
  'task-override': ['diagnose', 'issue', 'consume'],
  'task-lifecycle': ['intent'],
  'task-finalization': ['complete'],
  'task-short-id': ['list', 'list-verify', 'alloc', 'release', 'resolve'],
  'task-snapshot': ['snapshot'],
  'task-verify': ['event'],
  'task-validate': ['snapshot', 'inplace']
} as const);
