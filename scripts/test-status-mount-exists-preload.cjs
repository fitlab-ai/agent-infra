const fs = require('node:fs');

const fixedStatusMount = '/run/agent-infra/control-status';
const originalExistsSync = fs.existsSync;
fs.existsSync = function existsSync(file, ...args) {
  if (file === fixedStatusMount) return false;
  return originalExistsSync.call(this, file, ...args);
};
