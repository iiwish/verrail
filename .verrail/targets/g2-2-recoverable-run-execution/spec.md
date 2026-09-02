# G2.2 Spec - Recoverable Run Execution

## Problem

G2.1 binds a native Agent Run to an immutable DeploymentRevision and AgentVersion,
but the Run has no first-class Attempt, lease, event cursor, fencing, cancellation,
or durable RunWorkflow coordination. A lost executor or delayed callback can therefore
not yet be adjudicated as a governed execution fact.

## Goal

Make one HostTrusted local Agent Run recoverable across claim, heartbeat, event
delivery, failure, retry, cancellation, and delayed results without allowing an old
Attempt to overwrite the current Attempt.

## Scope

- Add Workspace-scoped RunAttempt, ExecutionLease, and RunEvent facts.
- Fix every Attempt to the Run's DeploymentRevision and AgentVersion.
- Allocate monotonically increasing fencing tokens per Run.
- Enforce one current Attempt and one active lease per Run.
- Make lease claim and heartbeat explicit, bounded, and idempotent.
- Accept ordered events with duplicate replay and gap rejection.
- Model completion, failure, retry, cancellation requested, cancellation
  acknowledged, and terminated states through domain commands.
- Add a replay-safe Temporal RunWorkflow with stable identity, versioned signals,
  retry policy, cancellation coordination, and Continue-As-New.
- Project Attempt and lease state in the Target workspace and Runs UI.

## Non-goals

- Remote Gateway or Runner protocol, enrollment, certificate rotation, fleet
  scheduling, or customer VPC transport.
- Strong-isolation production claims or SandboxDriver implementation.
- IntegrationAttempt, HumanWorkResult, Artifact, Evidence, Submission, Review, or
  Acceptance behavior.
- Replacing inherited heartbeat execution.

## Constraints

- PostgreSQL remains the only business fact source.
- Graph Engine remains authoritative for WorkNode transitions.
- Temporal coordinates only versioned domain commands and signals.
- Every mutable command is Workspace-scoped, idempotent, audited, and fenced.
- Expired or superseded Attempt callbacks may be recorded for audit but cannot
  change Run, WorkNode, or current Attempt state.
- RunEvent Cursor must be exactly next or an exact duplicate of an existing event.
- HostTrusted is a declared weak-isolation profile and cannot satisfy a strong
  isolation requirement.

## Acceptance Criteria

1. Contracts are synchronized across DB, shared, Go, TypeScript, and UI.
2. Attempt identity and fencing are immutable and monotonic.
3. Lease expiry and retry reject stale authoritative writes.
4. Event ordering is deterministic and idempotent.
5. Completion, failure, and cancellation converge all affected domain facts.
6. RunWorkflow is replay-safe, retry-safe, recoverable, and bounded in history.
7. Browser and automated fault acceptance prove the complete HostTrusted slice.

## Risks

- The combined G1/G2 branch still contains the migration 0234 rolling-upgrade
  blocker documented in the G2.0 review.
- A local executor identity is not remote Runner authentication; the UI and docs
  must not imply G3 private execution readiness.
- Artifact and Evidence validation is intentionally absent, so a succeeded Run does
  not by itself prove Target acceptance.

## Review Boundary

Implementation self-review can only mark this target ready for independent review.
It cannot grant product acceptance, merge, deployment, release, or ship authority.
