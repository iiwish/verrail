# T007 TDD Log

## RED

- A stored `accepted` Target label was able to look green without current adjudication facts.
- Target Timeline ignored audit events owned by Submission and other subordinate aggregates.
- A new ArtifactRevision did not visibly invalidate the prior Submission/Acceptance outcome.
- Home had no native Target attention source without creating an inherited Issue or Heartbeat.

## GREEN

- Added the seven-control Outcome and advisory available-command contracts.
- Added one deterministic projection over active Graph, current artifact/verification bindings,
  latest Submission, Review, Acceptance and external effects.
- Included subordinate aggregate audit events and native Target attention.
- Added a database status vocabulary check and regenerated migration metadata.

## REFACTOR

- Centralized fact loading and projection in `deriveTargetProjection` so Target list,
  workspace detail and Home attention share the same validity rules.
- Kept mutation authorization out of the projection and left every command route authoritative.

## Verification Note

The stable full suite passed the server and UI projects. Its CLI project changed HOME by design,
which made the Corepack shim attempt a network download before the tested server could start.
The harness now preserves the installed Corepack cache; the isolated end-to-end suite passed.
