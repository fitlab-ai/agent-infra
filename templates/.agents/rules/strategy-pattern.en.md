# Strategy Pattern

This rule applies during technical design and implementation. When behavior differs by platform, client, protocol, workflow, business rule, or algorithm, use interfaces to isolate implementations so shared flows can reuse them instead of creating a dedicated path for every scenario.

## Design Steps

1. **Separate shared flows from different implementations**: identify common steps and the behavior that differs by platform, client, protocol, workflow, business rule, algorithm, or lifecycle.
2. **Define the interface contract**: specify the inputs, outputs, error semantics, and invocation timing shared by implementations. The common flow depends on the interface, not a concrete implementation.
3. **Apply the Strategy Pattern**: provide an implementation for each behavior and select a strategy at registration or assembly. The common flow orchestrates shared steps without spreading conditions that identify concrete implementations.
4. **Verify substitutability**: a new implementation should connect through registration or assembly. Write shared tests for the interface contract and the necessary tests for strategy selection and full assembly.

## Implementation Requirements

- When the requirement clearly includes multiple behaviors, prefer the Strategy Pattern even if there is currently one implementation; the interface should express their stable shared contract.
- When adding behavior, prefer adding a strategy implementation and registering or assembling it in one place. Do not copy a full business flow or repeat the same branch across callers.
- If branches that identify implementations are already scattered across paths, consolidate those decisions at strategy selection and make callers depend on the interface.
- Reuse existing interfaces and domain terms. Do not rename code to apply a pattern or add interfaces to stable behavior that has no meaningful alternatives.
- Keep stable, single-purpose behavior direct when there is no evidence it will vary. Do not mechanically add interfaces, configuration, or extension points.

## Design Review Questions

- Which steps are shared by all implementations, and which behaviors differ by platform, client, or business rule?
- Does the interface express the contract shared by the implementations?
- Can a new behavior be added by implementing a strategy and assembling it in one place? If several call paths must change, is centralized strategy selection missing?
- Can the same interface tests validate the shared contract while strategy differences are tested independently?
