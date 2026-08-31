# M0 Integration And Merge Closure Spec

## Problem

The B2 read model, native Go Target command, B3 Temporal workflow, and B2.1 projection hardening exist together in an uncommitted working tree. Focused checks pass, but the repository-wide test result is contaminated by concurrent local services, the default development process does not prove one shared database across every runtime, and the accumulated diff is too broad for a reliable merge decision.

## Goal

Produce a reproducible, reviewable merge candidate without adding new domain capability.

## Context

PostgreSQL remains the business fact source. The Go Domain API owns native Target writes. Temporal owns durable orchestration history but not business decisions. The TypeScript server remains the compatibility edge during progressive migration.

## Scope

- Establish an isolated full-suite baseline and distinguish inherited failures from current regressions.
- Verify fresh and upgrade database migrations through the Target and outbox migrations.
- Provide one documented local integration entry point with shared PostgreSQL and explicit health checks.
- Prove native Target creation through outbox dispatch to Temporal, including idempotency and restart recovery.
- Preserve compatibility projection isolation, reconciliation, authorization, and immutable revisions.
- Split and commit the accumulated work into reviewable dependency-ordered changes.
- Attach run evidence and draft a merge-readiness decision.

## Non-goals

- Graph planning or activation.
- Agent execution or adapter migration.
- Artifact, Evidence, Submission, Review, or Acceptance implementation.
- Broad repair of inherited Paperclip behavior unrelated to the merge delta.
- Push, merge, deploy, release, or final self-approval.

## Constraints

- Do not discard or overwrite unrelated user work.
- Do not rewrite published migration history or immutable Target revisions.
- Do not weaken Workspace authorization, outbox ordering, idempotency, or Temporal replay safety.
- Do not claim exactly-once delivery across PostgreSQL and Temporal.
- No outbound Telemetry changes.

## Acceptance Criteria

The criteria in `target.json` are authoritative.

## Risks

- A polluted local baseline can hide regressions or create false failures.
- Incorrect commit boundaries can separate a migration from required schema, API, or test changes.
- A convenient dev launcher can accidentally imply production support or hide unhealthy dependencies.
- Workflow assertions can pass against the wrong PostgreSQL database unless identities and outbox rows are correlated explicitly.

## Open Questions

- Final merge approval remains a human decision after the evidence and commit series are available.
