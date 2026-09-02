# G2.1 Maintainer Review

Decision: **ready for independent review; not approved for production release**.

## Findings

### P1 - Combined-branch production rollout is still blocked

`packages/db/src/migrations/0234_good_nighthawk.sql:21` removes the legacy
`verrail_targets.project_id` column. That G1 migration predates G2.1, but it remains
in this delivery branch and prevents a safe rolling deployment with a pre-G1
service. G2.1 migrations 0236 and 0237 are additive; production rollout of the
combined branch still requires an approved expand/contract sequence or a
stopped-write maintenance window with a current backup.

### P2 - Evaluation truth is recorded, not independently executed

`services/domain-api/internal/target/agent_lifecycle_store.go:198` accepts a human
recorded EvaluationRun and `agent_lifecycle_store.go:237` correctly requires both
the evaluation and safety result to pass before deployment. G2.1 therefore closes
the identity and gate contract, but not evaluator execution, dataset provenance,
Evidence binding, or independent assurance. Those controls must remain explicit
follow-up scope and the current UI must not be read as automated certification.

### P2 - Runtime acceptance cannot yet close the Target

The live G2.1 Target remains `draft` in Define because product-native Artifact,
Evidence, DeliveryReview, and Acceptance write commands are not implemented. The
repository-native receipt and evidence package is inspectable, but it does not
substitute for target-bound acceptance authority.

### P2 - Rollback UI chooses the immediately preceding revision

`ui/src/pages/VerrailAgents.tsx:112` implements the compact rollback action by
selecting the second-latest DeploymentRevision. The domain command supports any
historical revision, but the current UI does not expose a revision picker. This is
adequate for the G2.1 one-step rollback slice and was accepted in the live flow;
operators need explicit revision selection before deeper deployment histories are
treated as production-ready.

## Verified In G2.1

- AgentVersion facts are immutable, content-addressed, and monotonically numbered.
- Evaluation and safety gates reject mismatched or non-passing versions.
- Deployment changes create immutable revisions with audited pause, resume,
  default, upgrade, rollback, and retirement behavior.
- Graph creation accepts only the latest active DeploymentRevision, and Agent Run
  creation persists that DeploymentRevision and its fixed AgentVersion.
- Workspace membership, Workspace-scoped foreign keys, idempotency receipts,
  serializable transactions, and default uniqueness are enforced.
- Fresh Workspaces receive a paused default compatibility identity whose evaluation
  is intentionally inconclusive and cannot activate production execution.
- Typecheck, build, Go tests, migration checks, token gates, browser acceptance,
  focused lifecycle tests, and formatting checks passed. Full UI and DB concurrency
  failures were resource/timing-only and passed serial follow-up.

## Review Boundary

No P0 or G2.1-specific P1 defect blocks independent review. This is a self-review
and cannot satisfy independent approval, product acceptance, merge, deployment,
release, or ship authority.
