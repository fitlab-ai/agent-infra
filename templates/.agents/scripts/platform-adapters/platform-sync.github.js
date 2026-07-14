import { pathToFileURL } from "node:url";

import {
  formatAgentInfraPackageError,
  resolveAgentInfraPackage
} from "../lib/agent-infra-package.js";

const CHECK_TYPE = "platform-sync";
const packageResolution = resolveAgentInfraPackage();
let runtime = null;
let loadError = null;

if (packageResolution.runtimePath) {
  try {
    runtime = await import(pathToFileURL(packageResolution.runtimePath).href);
  } catch (error) {
    loadError = error;
  }
}

function resolutionError() {
  if (loadError) {
    return [
      formatAgentInfraPackageError(packageResolution),
      `The package runtime could not be loaded: ${loadError instanceof Error ? loadError.message : String(loadError)}`
    ].join("\n");
  }
  return formatAgentInfraPackageError(packageResolution);
}

export function getDefaults() {
  return runtime?.getDefaults?.() || { statusLabels: {}, markers: {} };
}

export function check(context, shared) {
  if (!runtime?.check) {
    return shared.blockedResult(CHECK_TYPE, resolutionError(), "dependency_error");
  }
  return runtime.check(context, shared);
}
