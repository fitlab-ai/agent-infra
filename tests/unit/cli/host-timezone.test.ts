import test from "node:test";
import assert from "node:assert/strict";

import { loadFreshEsm } from "../../helpers.ts";

type HostTimezoneModule = {
  detectHostTimezone(options?: {
    platform?: NodeJS.Platform;
    readlink?: (targetPath: string) => string;
    env?: NodeJS.ProcessEnv;
  }): string | null;
};

test("detectHostTimezone prefers an explicit TZ environment value", async () => {
  const { detectHostTimezone } = await loadFreshEsm<HostTimezoneModule>("lib/sandbox/host-timezone.js");

  assert.equal(
    detectHostTimezone({
      platform: "linux",
      readlink() {
        return "/usr/share/zoneinfo/Asia/Shanghai";
      },
      env: { TZ: "Europe/Paris" }
    }),
    "Europe/Paris"
  );
});

test("detectHostTimezone extracts a macOS zoneinfo symlink target", async () => {
  const { detectHostTimezone } = await loadFreshEsm<HostTimezoneModule>("lib/sandbox/host-timezone.js");

  assert.equal(
    detectHostTimezone({
      platform: "darwin",
      readlink() {
        return "/var/db/timezone/zoneinfo/Asia/Shanghai";
      },
      env: {}
    }),
    "Asia/Shanghai"
  );
});

test("detectHostTimezone extracts a Linux zoneinfo symlink target", async () => {
  const { detectHostTimezone } = await loadFreshEsm<HostTimezoneModule>("lib/sandbox/host-timezone.js");

  assert.equal(
    detectHostTimezone({
      platform: "linux",
      readlink() {
        return "/usr/share/zoneinfo/Asia/Shanghai";
      },
      env: {}
    }),
    "Asia/Shanghai"
  );
});

test("detectHostTimezone returns null when no safe host timezone is available", async () => {
  const { detectHostTimezone } = await loadFreshEsm<HostTimezoneModule>("lib/sandbox/host-timezone.js");

  assert.equal(detectHostTimezone({ platform: "win32", env: {} }), null);
  assert.equal(
    detectHostTimezone({
      platform: "linux",
      readlink() {
        throw new Error("ENOENT");
      },
      env: {}
    }),
    null
  );
  assert.equal(detectHostTimezone({ platform: "linux", env: { TZ: "Europe/Paris with space" } }), null);
  assert.equal(
    detectHostTimezone({
      platform: "linux",
      readlink() {
        return "/usr/share/zoneinfo/../Europe/Paris";
      },
      env: {}
    }),
    null
  );
});
