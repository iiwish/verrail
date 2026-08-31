# B2.1 Target Projection Compatibility And Merge Readiness Spec

## Problem

Persisted compatibility projections are JSON snapshots, but the read path trusts their compile-time TypeScript type. A pre-contract snapshot that lacks `authority` and `definition` reaches route authorization and causes a raw `TypeError`, taking Workspace and Project Target lists down with it.

## Goal

Make projection evolution explicit, bounded, observable, and safe enough for merge review while preserving immutable revisions and the separation between compatibility projections and native Go-owned Target facts.

## Scope

- Define the canonical TargetReadModel runtime schema in the shared contract package.
- Accept exactly one known legacy compatibility shape and normalize it in memory.
- Validate JSON identity against relational Workspace, Target, revision, source, schema, and projection-policy facts.
- Keep detail failures explicit and retryable; isolate invalid list entries so other Targets remain usable.
- Use the existing administrator reconciliation command as the durable re-projection path.
- Prove legacy read availability followed by reconciliation to a canonical active snapshot.
- Repeat focused, repository-wide, Go, browser, and integrated orchestration checks.

## Non-goals

- Reads do not update snapshots, source rows, or compatibility source objects.
- The upgrader does not guess missing business facts or accept arbitrary malformed JSON.
- This goal does not add a general workflow designer, Graph execution, or assurance objects.
- This goal does not authorize commit, merge, deployment, release, or self-approval.

## Constraints

- PostgreSQL remains the business fact source; compatibility snapshots remain rebuildable.
- Immutable historical revision IDs and snapshot JSON are not rewritten by ordinary reads.
- Native Target creation remains owned exclusively by the Go Domain API.
- Errors must not leak cross-Workspace object existence.
- No new outbound Telemetry is introduced.

## Acceptance Criteria

The criteria in `target.json` are authoritative.

## Risks

- An overly permissive upgrader could hide corruption or invent authority.
- Silently dropping invalid list entries could conceal an operational problem unless logs and detail errors remain explicit.
- Reconciliation must not change stable Target identity or rewrite historical revisions.
- Independent B2 and B3 checks can pass while a one-stack UI-to-Temporal path remains unproven.

## Open Questions

- Production-wide projection repair and shadow-table rebuild remain operations work beyond this pre-release compatibility repair.
- The inherited repository-wide test baseline must be resolved or explicitly accepted before a release candidate is claimed.
