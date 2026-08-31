# B3 Acceptance Mapping

1. **Covered.** `contracts.go`, worker registration, unit tests, live Temporal describe, and the screenshot show the versioned Workflow, Signal, Query, task queue, and stable Workspace/Target Workflow ID.
2. **Covered.** `store.go`, migration 0230, and the real PostgreSQL integration test prove skip-locked claim, unique token, bounded lease, aggregate ordering, and transaction release before delivery.
3. **Covered.** `temporal.go` sends the event and aggregate identities through `SignalWithStart`; all acknowledgement paths require the current claim token.
4. **Covered.** Unit and real outage checks prove bounded exponential retry, expired-lease reclaim, stale-token rejection, unsupported-event failure, retry exhaustion, and failed-event quarantine.
5. **Covered.** Workflow tests and captured-history replay prove minimal orchestration state, duplicate and cross-aggregate rejection, a versioned query, bounded event memory, and queued-signal preservation at Continue-As-New.
6. **Covered.** A Target command returned 201 while Temporal was stopped; its outbox event recorded retries and delivered after recovery without changing or rolling back the Target fact.
7. **Covered.** The local image is pinned, persists development history, binds to loopback, and runs separately from both Go commands.
8. **Covered.** Focused Go tests, a real PostgreSQL store test, real SignalWithStart and query checks, live outage recovery, captured replay history, and Temporal UI evidence are attached.
9. **Covered.** Canonical architecture, read-model, runtime, index, environment, and development documentation state the implemented boundary and explicitly leave Graph and Run outside the slice.

The repository-wide Vitest result retains the exact inherited 24-failure baseline. This is a release-readiness gap, not a failed B3 acceptance criterion.
