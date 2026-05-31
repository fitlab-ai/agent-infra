import fs from "node:fs";

type TestPlatform = "linux" | "darwin" | "win32";

const realPlatform = process.platform;

function supportsPosixModeBits(): boolean {
  return realPlatform !== "win32";
}

function assertModeBits(filePathname: string, expectedMode: number): void {
  if (!supportsPosixModeBits()) {
    return;
  }

  const actualMode = fs.statSync(filePathname).mode & 0o777;
  assertEqual(actualMode, expectedMode);
}

/**
 * Restrict a node:test case to the listed Node.js process.platform values.
 *
 * Use this as the test options argument: test(name, onPlatforms("linux", "darwin"), fn).
 * Allowed values are "linux", "darwin", and "win32". Do not use early returns
 * such as `if (process.platform === "...") return;` to skip a whole test body.
 *
 * Branching on process.platform inside a test remains valid when the same test
 * intentionally covers platform-specific assertions or fixture construction.
 */
function onPlatforms(...allowed: TestPlatform[]): { skip: false | string } {
  return {
    skip: allowed.includes(process.platform as TestPlatform)
      ? false
      : `requires ${allowed.join("/")} (current: ${process.platform})`
  };
}

function assertEqual(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`Expected mode ${expected.toString(8)}, got ${actual.toString(8)}`);
  }
}

export {
  assertModeBits,
  onPlatforms,
  supportsPosixModeBits
};
