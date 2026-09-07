const fs = require('node:fs');

const fixedStatusMount = '/run/agent-infra/control-status';
const originalExistsSync = fs.existsSync;
const originalStatSync = fs.statSync;
const fsBinding = process.binding('fs');
const originalInternalModuleStat = fsBinding.internalModuleStat;
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
fsBinding.internalModuleStat = function internalModuleStat(file) {
  if (file === fixedStatusMount) return -2;
  return originalInternalModuleStat.call(this, file);
};
