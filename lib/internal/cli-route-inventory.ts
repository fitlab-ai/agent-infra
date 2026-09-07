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

/**
 * The selector definitions consumed by every internal handler. Keep this
 * module free of handler imports so the pre-import task-view guard remains
 * effective.
 */
export const INTERNAL_HANDLER_ROUTE_SELECTORS = Object.freeze({
  'task-create': ['input'],
  'task-qualification': ['proposal', 'confirm', 'supersede', 'revoke'],
  'sandbox-control': ['serve', 'execute', 'recover', 'client'],
  'agent-client': ['next-steps', 'model-selection'],
  'codex-lifecycle': ['preflight', 'capability-arm', 'hook-event', 'resolve-start', 'resolve-stop', 'consume'],
  'codex-sandbox-controller': ['verify-context', 'run'],
  'git-workflow': ['inspect', 'preview-tree', 'snapshot', 'compare-trees', 'commit', 'push-rebased'],
  'task-delivery': ['deliver'],
  'release-workflow': ['inspect', 'prepare', 'publish', 'post-prepare', 'post-publish'],
  'platform-release-notes': ['context', 'stage', 'publish'],
  'platform-security': ['read', 'dismiss'],
  'platform-metadata': ['init-labels', 'init-milestones'],
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
  'task-artifact': ['inspect', 'init', 'repair', 'finalize-local'],
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

export const INTERNAL_CLI_ROUTE_SELECTORS = INTERNAL_HANDLER_ROUTE_SELECTORS;

function first(args: readonly string[]): string {
  return args[0] ?? '';
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function internalRouteSelector(command: string, args: readonly string[]): string {
  if (command === 'sandbox-control') return first(args);
  if (command === 'task-create') return 'input';
  if (command === 'task-qualification') return args[1] ?? '';
  if (command === 'task-lifecycle') return args[1] ? 'intent' : '';
  if (command === 'task-finalization') return args[1] === 'complete' ? 'complete' : '';
  if (command === 'task-event') return args[1] ? 'event' : '';
  if (command === 'task-verify') return args[0] && args[1] ? 'event' : '';
  if (command === 'task-snapshot') return 'snapshot';
  if (command === 'task-validate') return optionValue(args, '--scope') ?? 'snapshot';
  if (command === 'task-short-id') return first(args) === 'list' && args.includes('--verify') ? 'list-verify' : first(args);
  if (command === 'task-orchestration') return args[1] === 'status' ? 'status' : args[1] ? 'progress' : '';
  if (command === 'task-review') return args[1] ?? '';
  if (command === 'task-invalidation') return args[1] ?? '';
  if (command === 'task-override') return args[1] ?? '';
  if (command === 'task-artifact') return args[1] ?? '';
  if (command === 'platform-pr-review' && first(args) === 'publish') {
    const scope = optionValue(args, '--scope') ?? '';
    return /^TASK-\d{8}-\d{6}$/u.test(scope) ? 'publish-task' : /^pr\d+$/u.test(scope) ? 'publish-pr' : '';
  }
  if (['task-ledger', 'task-warning', 'task-activity'].includes(command)) return args[1] ?? '';
  if (command === 'task-delivery') return args[1] ?? '';
  if (command === 'task-context') return first(args);
  return first(args);
}

export function isInternalHandlerRoute(command: string, args: readonly string[]): boolean {
  if (args[0] === '--help' || args[0] === '-h') return true;
  const selector = internalRouteSelector(command, args);
  const selectors = INTERNAL_HANDLER_ROUTE_SELECTORS[command as keyof typeof INTERNAL_HANDLER_ROUTE_SELECTORS];
  return Boolean(selector && selectors?.some((candidate) => candidate === selector));
}

/**
 * Marks a selector at the handler's actual dispatch branch.
 *
 * The call is intentionally side-effect free so the top-level task-view guard
 * can still run before a handler module is imported. Route coverage tests read
 * these branch markers independently from the pre-import inventory.
 */
export function internalHandlerRoute(command: string, selector: string, actualSelector: string): boolean {
  return command.length > 0 && selector === actualSelector;
}

export function ensureInternalHandlerRoute(command: string, args: readonly string[]): boolean {
  if (isInternalHandlerRoute(command, args)) return true;
  const selector = internalRouteSelector(command, args);
  process.stdout.write(`${JSON.stringify({
    status: 'failed',
    changed: false,
    error: { code: 'INTERNAL_ROUTE_UNREGISTERED', message: `operation '${command} ${selector || first(args)}' is not registered` }
  })}\n`);
  process.exitCode = 1;
  return false;
}
