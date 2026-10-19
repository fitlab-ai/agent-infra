const fs = require('node:fs');
const path = require('node:path');

const taskWorkspaceFixtureRoot = process.env.AGENT_INFRA_TEST_TASK_WORKSPACE_ROOT;
if (taskWorkspaceFixtureRoot) {
  const mount = '/task-workspace';
  const mapTaskWorkspacePath = (value) => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return value;
    const pathname = value instanceof URL ? value.pathname : value.toString();
    if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return value;
    const relative = pathname.slice(mount.length).replace(/^\/+/, '');
    return path.join(taskWorkspaceFixtureRoot, relative);
  };
  const originalNativeRealpath = fs.realpathSync.native;
  for (const method of [
    'accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'existsSync',
    'lstatSync', 'mkdirSync', 'openSync', 'readFileSync', 'readdirSync', 'realpathSync',
    'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'unlinkSync', 'utimesSync', 'writeFileSync'
  ]) {
    const original = fs[method];
    if (typeof original !== 'function') continue;
    fs[method] = function mapTaskWorkspaceFirstPath(file, ...args) {
      return original.call(this, mapTaskWorkspacePath(file), ...args.map(mapTaskWorkspacePath));
    };
  }
  if (typeof originalNativeRealpath === 'function') {
    fs.realpathSync.native = function mapTaskWorkspaceNativeRealpath(file, ...args) {
      return originalNativeRealpath.call(this, mapTaskWorkspacePath(file), ...args);
    };
  }
}

const fixedStatusMount = '/run/agent-infra/control-status';
const originalBinding = process.binding;
const originalToString = Function.prototype.toString;
const originalExistsSync = fs.existsSync;
const originalStatSync = fs.statSync;
fs.existsSync = function existsSync(file, ...args) {
  if (file === fixedStatusMount) return false;
  return originalExistsSync.call(this, file, ...args);
};
fs.statSync = function statSync(file, ...args) {
  if (file === fixedStatusMount) {
    const error = new Error('ENOENT: test isolation hides fixed status mount');
    error.code = 'ENOENT';
    throw error;
  }
  return originalStatSync.call(this, file, ...args);
};

// The test runner executes inside a task sandbox in some environments. Model
// its child CLI processes as direct-host callers while leaving production's
// native mount probe intact. Security tests that need the real mount clear
// NODE_OPTIONS for their isolated child process.
const nativeLikeInternalModuleStat = function internalModuleStat(file) {
  if (file === fixedStatusMount) return -2;
  return originalBinding('fs').internalModuleStat(file);
};
Function.prototype.toString = function toString() {
  if (this === nativeLikeInternalModuleStat) return 'function internalModuleStat() { [native code] }';
  return originalToString.call(this);
};
process.binding = function binding(name) {
  const value = originalBinding(name);
  if (name !== 'fs') return value;
  return { ...value, internalModuleStat: nativeLikeInternalModuleStat };
};
