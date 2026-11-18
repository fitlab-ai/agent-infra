# Strategy and Template Method

During design and implementation, trace the rule being changed through its callers. Identify where the decision belongs and which callers only consume its result. Keep stable behavior direct. Use a variation already present in the code or required by the task to justify an extension point.

## Strategy for interchangeable behavior

- When the requirement establishes interchangeable behaviors, make the shared flow depend on a strategy contract even if only one implementation exists today. Define the contract shared by the implementations, including inputs, outputs, error behavior, and when the operation is called. Reuse an existing contract where possible. A function signature can be sufficient.
- When an explicit key selects an implementation, prefer a registry such as a typed record or map from key to strategy. Resolve it at the assembly boundary and call the selected implementation through its contract. Handle unknown keys according to the current contract.
- Adding an implementation should normally require implementing the behavior and registering it once. If selection depends on ordered predicates, preserve their precedence in one selector. Keep validation and state transitions explicit when their branches express business rules.
- Verify the shared contract across implementations and the selection of the intended strategy at the boundary.

## Template Method for a shared sequence

- When implementations must perform the same business steps in the same order and only particular steps vary, define the sequence once in a template method. The base class owns sequencing and shared guarantees. Subclasses implement the varying steps.
- For example, if every importer must validate before writing, the template owns both calls and the rule that validation failure prevents the write. A subclass can decode its own format without taking over that sequence.
- If the existing design uses functions, a shared orchestrator with injected step functions can preserve the same sequence. If variants repeatedly skip or reorder required steps, reconsider which sequence they actually share.
- Verify the common ordering and failure behavior at the template entry point. Test the differing steps in their implementations.

## Review a concrete change

Trace one variation supported by the requirement. For a new strategy, locate its implementation and registration. For a shared sequencing change, locate the template and check which subclasses would need edits. If several callers must independently reinterpret the same rule, identify what diverges when one is missed. A lower complexity score alone does not demonstrate that the decision has a single owner.
