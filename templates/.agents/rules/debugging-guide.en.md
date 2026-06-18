# General Rule - Structured Debugging Guide

> This file defines the structured triage flow for "test failure / behavior not as expected"; SKILLs that modify code in response to failures (e.g. `code-task`, `watch-pr`) load it on demand before attempting a fix.

## Triggers

When any of the following happens, run this flow before changing code:

- A test fails, or a build / type-check / lint error appears
- Runtime behavior differs from expectations (output, state, or side effects)

## Core Anti-pattern: No Blind Patch-and-Retry

The "tweak one spot → rerun → still broken → guess another spot" loop hides the real root cause, introduces new defects, and wastes time. A change with no supporting evidence is not a fix.

## Four-phase Flow

1. **Gather evidence**: Read the full error message and stack trace (not just the last line) and pinpoint where it fails; reproduce minimally when needed, and record "actual vs expected behavior".
2. **Form a hypothesis**: From the evidence, propose a root-cause hypothesis that explains **all** the symptoms rather than a surface symptom; if there are several, rank them by likelihood and testability.
3. **Verify the hypothesis**: Before changing anything, confirm the hypothesis cheaply—add logging, add a breakpoint, shrink the input, or write a failing test that reproduces it; if it is disproven, return to phase 2.
4. **Fix the root cause**: Change only the verified root cause (not the symptom), then rerun the relevant tests to confirm they pass; if they still fail, return to phase 1 with the new evidence instead of trial-and-error without evidence.

## Relation to Project Principles

This flow is the debugging-specific form of AGENTS.md's "Think Before Coding" and "Goal-Driven Execution": pin the problem with a reproducible failing case first, then make the fix turn it green.
