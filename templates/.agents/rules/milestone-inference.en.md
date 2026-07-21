# Milestone Inference

This code platform does not provide milestone inference; `platform-issue sync --milestone ...` returns a structured no-op/degraded result.

Milestone narrowing and reuse are skipped for custom platforms unless you provide matching `.{platform}.en.md` rule templates. Do not block task progress when no platform-specific milestone implementation is available.
