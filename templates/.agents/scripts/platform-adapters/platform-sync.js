export function check(_context, shared) {
  return shared.passResult(
    "platform-sync",
    "Skipped: this code platform does not provide a built-in platform-sync adapter"
  );
}
