const fs = require('node:fs');

const fixedStatusMount = '/run/agent-infra/control-status';
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
