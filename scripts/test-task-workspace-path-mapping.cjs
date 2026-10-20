const fs = require('node:fs');
const path = require('node:path');

function installTaskWorkspacePathMapping(root) {
  const mount = '/task-workspace';
  const mapPath = (value) => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return value;
    const pathname = value instanceof URL ? value.pathname : value.toString();
    if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return value;
    return path.join(root, pathname.slice(mount.length).replace(/^\/+/, ''));
  };
  const methods = [
    'accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'existsSync',
    'lstatSync', 'mkdirSync', 'openSync', 'readFileSync', 'readdirSync', 'realpathSync',
    'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'unlinkSync', 'utimesSync', 'writeFileSync'
  ];
  const originals = new Map();
  const nativeRealpath = fs.realpathSync.native;
  for (const method of methods) {
    const original = fs[method];
    if (typeof original !== 'function') continue;
    originals.set(method, original);
    fs[method] = function mapTaskWorkspacePaths(first, ...args) {
      const mappedArgs = method === 'renameSync' || method === 'copyFileSync'
        ? [mapPath(args[0]), ...args.slice(1)]
        : args;
      return original.call(this, mapPath(first), ...mappedArgs);
    };
  }
  if (typeof nativeRealpath === 'function') {
    fs.realpathSync.native = function mapTaskWorkspaceNativeRealpath(file, ...args) {
      return nativeRealpath.call(this, mapPath(file), ...args);
    };
  }
  return () => {
    for (const [method, original] of originals) fs[method] = original;
    if (typeof nativeRealpath === 'function') fs.realpathSync.native = nativeRealpath;
  };
}

module.exports = { installTaskWorkspacePathMapping };
