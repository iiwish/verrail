# T005 Verification Development Log

## Context

The resumed run already contained a partial active-workflow implementation and no new behavioral tests. The remaining work used review-driven test construction rather than claiming an unobserved RED phase.

## Findings And Fixes

1. Existing tests compiled but did not exercise Activities, child workflows, recovery, or PostgreSQL facts.
2. A stale `run.attempt_created` signal could replace the current Attempt identity. The event guard now rejects every non-RunCreated event for an older Attempt.
3. A heartbeat-extended lease could make a recovery check collide with the still-live Attempt. Service scheduling now returns that current Attempt and its authoritative grace expiry; human scheduling retains the existing conflict behavior.
4. Lease-expiry recovery had no domain-enforced maximum. `maxAttempts` is checked transactionally before creating a new Attempt and exhaustion becomes a non-retryable Workflow error.
5. Graph reconciliation required a Target status not produced by the existing creation and activation commands. Reconciliation now binds the active TargetRevision and GraphRevision without inventing a Target status transition owned by T007.
6. Active workflow code required version gates to replay v1 signal-only histories. Target and Run paths now preserve DefaultVersion behavior and adopt Activities in a new Workflow Run.

## Coverage Added

- dependency wait and one-time activation;
- service and human scheduling compatibility;
- idempotent Run and reconciliation facts;
- Activity retry identity and stable Run child Workflow ID;
- live Attempt reuse, lease expiry, higher fencing, and stale Attempt rejection;
- max-attempt exhaustion;
- cancellation Activity in disconnected context;
- Target and Run Continue-As-New state;
- legacy version paths and captured history replay;
- real Temporal worker stop/start plus live server-history replay for both workflows.
