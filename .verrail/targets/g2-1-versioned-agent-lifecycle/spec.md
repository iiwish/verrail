# G2.1 - Versioned Agent Lifecycle

## Problem

The inherited Agent record is mutable and native WorkGraph and Run commands can
store arbitrary principal identifiers. Verrail therefore cannot yet prove which
published Agent configuration received a production invocation.

## Goal

Make an active DeploymentRevision, which fixes one immutable AgentVersion, the
resolvable native production identity for Agent work.

## Scope

- Add Workspace-scoped AgentDefinition, AgentVersion, Deployment,
  DeploymentRevision, and EvaluationRun facts.
- Preserve inherited Agent behavior through an explicit compatibility link.
- Publish immutable, content-addressed versions from editable definitions.
- Gate active production deployments on a passing EvaluationRun.
- Maintain exactly one resolvable default Deployment per Workspace.
- Bind native AgentTask responsibility and Run creation to a fixed active
  DeploymentRevision and AgentVersion.
- Provide a focused Agents UI for the lifecycle.

## Non-goals

- Full Runner, lease, fencing, RunAttempt, Connector, or assurance closure.
- Replacing inherited adapter configuration, secrets, skills, or run history.
- Production release or migration approval.

## Constraints

- Published AgentVersion and DeploymentRevision rows are immutable.
- All lifecycle reads and writes enforce Workspace scope.
- Draft definitions and paused deployments cannot receive native production work.
- Default Deployment selection grants no capability by itself.
- Existing mutable Agent rows and APIs remain available during migration.
- Every mutation is idempotent and produces an audit fact.

## Acceptance Criteria

Acceptance is defined by `target.json`. Evidence must demonstrate rejection of
unpublished, unevaluated, paused, cross-Workspace, stale, and arbitrary identities,
not only the successful path.

## Risks

- A compatibility backfill could incorrectly turn a mutable inherited Agent into
  a production deployment.
- Concurrent publish or default-selection commands could create split identity.
- UI affordances could imply approval that the domain facts do not grant.

## Open Questions

None blocking. Full evaluation datasets and independent approval remain later G2
work; G2.1 records a basic externally supplied evaluation result with human command
authority and an explicit passing gate.
