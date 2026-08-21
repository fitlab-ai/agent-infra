export type SandboxControlBackoffStep = Readonly<{
  delayMs: number;
  nextDelayMs: number;
}>;

export function nextSandboxControlBackoff(currentDelayMs: number, capMs: number): SandboxControlBackoffStep {
  const delayMs = Math.min(currentDelayMs, capMs);
  return {
    delayMs,
    nextDelayMs: Math.min(capMs, delayMs * 2)
  };
}
