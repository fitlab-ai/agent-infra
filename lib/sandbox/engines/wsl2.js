const NOT_IMPLEMENTED = 'WSL2 sandbox engine is not implemented yet; Windows sandbox support is reserved for a future implementation.';

function notImplemented() {
  throw new Error(NOT_IMPLEMENTED);
}

export const wsl2Adapter = {
  id: 'wsl2',
  displayName: 'WSL2',
  dockerContext: null,
  managed: true,
  canApplyResources: 'on-start',

  defaultResources: notImplemented,

  ensure: notImplemented,
  startVm: notImplemented,
  stopVm: notImplemented,
  syncResources: notImplemented
};

export default wsl2Adapter;
