const fs = require('node:fs');

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
