# T004 Technical Review

Reviewer: Codex under delegated intermediate technical authority

This is an engineering dependency review, not a product DeliveryReview,
ActionApproval, Acceptance, release approval, or final Outcome Owner decision.

## Findings

No Critical or High findings remain.

- AgentTask, IntegrationTask, and HumanTask have separate result commands and
  store paths. An IntegrationTask can no longer be represented by CreateRun.
- New IntegrationRun writes are fixed to the active TargetRevision and
  GraphRevision, an IntegrationTask node, the Claim criterion, connector and
  Connection identity, commit, environment, and a credential-free receipt.
- The first IntegrationAttempt is inserted atomically with its IntegrationRun
  and has independent uniqueness for attempt number and provider idempotency.
- HumanWorkResult accepts only an authenticated human and stores a canonical
  result hash, input hash, optional ArtifactRevision, and attachment hashes.
- Workspace mismatch is rejected in the store before fact creation. Composite
  Workspace foreign keys protect all parents that expose compatible unique keys.
- Migration 0242 has no destructive statements and does not synthesize unknown
  values for legacy IntegrationRun rows.

Residual risk: scheduling additional IntegrationAttempts and reconciling provider
callbacks belong to the durable orchestration work in T005/T009. The inherited
`tool_connections` schema requires a transactional Workspace check rather than a
composite foreign key.

Recommendation: accept T004 for dependency progression.
