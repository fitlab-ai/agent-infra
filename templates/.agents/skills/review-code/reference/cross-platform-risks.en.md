# Cross-platform Risk Review

## Scope

Use when changes touch OS branches, path or case behavior, shells and commands, permissions, symlinks, newlines or encodings, signals and processes, or platform fallbacks.

When the change also touches test files and must express real platform guards or test execution scope, read `.agents/rules/cross-platform-tests.md` in full. That second-level rule governs test scope only; this file governs implementation semantics. Do not load the second level when tests are unchanged.

## Review Questions

- Do paths, shells, permissions, and process behavior use the real semantics of each target platform?
- Do platform fallbacks preserve consistent outcomes and distinguish unsupported behavior from runtime failure?
- Do tests execute on genuinely supported platforms instead of simulating coverage with early returns?

## Evidence Requirements

Record affected platforms, implementation branches, and fallback paths. When test scope is involved, also record second-level rule readiness and `onPlatforms()` guards.

## Common Counterexamples

- Inferring equivalence across platforms from success on the development platform.
- Simulating path or shell behavior with string concatenation.
- Loading the test-guard rule unconditionally for formal completeness.

## When Closure Is Not Possible

Record reproducible platform defects as findings, checks that only a specific real platform can close as manual-validation, and actual platform risks left uncovered by missing, unloaded, or insufficient rules as a gap. A structural gate cannot replace semantic judgment.
