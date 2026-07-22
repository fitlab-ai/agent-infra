export function getDefaults() {
  return { statusLabels: {}, markers: {} };
}

export function check(_context, shared) {
  return shared.passResult(
    "required-checks",
    "Skipped: this code platform does not provide a built-in required-checks adapter"
  );
}
