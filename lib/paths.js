import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function resolveBundledTemplateDir() {
  return fileURLToPath(new URL('../templates', import.meta.url));
}

function resolveCloneTemplateDir() {
  return path.join(os.homedir(), '.agent-infra', 'templates');
}

function normalizePath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function resolveTemplateDir() {
  // npm install mode: templates shipped alongside the package
  const npmPath = resolveBundledTemplateDir();
  if (fs.existsSync(npmPath)) {
    return npmPath;
  }

  // clone install mode: ~/.agent-infra/templates
  const clonePath = resolveCloneTemplateDir();
  if (fs.existsSync(clonePath)) {
    return clonePath;
  }

  return null;
}

function resolveInstallDir() {
  return path.join(os.homedir(), '.agent-infra');
}

function isCloneInstall() {
  const npmPath = resolveBundledTemplateDir();
  const clonePath = resolveCloneTemplateDir();
  return fs.existsSync(npmPath) && normalizePath(npmPath) === normalizePath(clonePath);
}

export { resolveTemplateDir, resolveInstallDir, isCloneInstall };
