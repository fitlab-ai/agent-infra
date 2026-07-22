import { check as checkPlatformSync, getDefaults } from "./platform-sync.js";

const CHECK_TYPE = "platform-sync-preflight";

export { getDefaults };

export function check(context, shared) {
  const result = checkPlatformSync(context, shared);
  return { ...result, type: CHECK_TYPE };
}
