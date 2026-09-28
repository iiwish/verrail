# T018 TDD Log

RED proved two gaps: model and prompt mismatches still launched heartbeat execution, and the version dialog defaulted to the nonexistent `codex-local` runtime identifier.

GREEN adds fail-closed equality checks for AgentVersion runtime/model/prompt against the compatibility Agent adapter snapshot and uses `codex_local` in the publishing UI.

Verification passed: runner 10/10, Agent lifecycle UI 4/4, server and UI typecheck, 817-file token gates, and diff check.
