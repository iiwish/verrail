# G2.2 Maintainer Review

Decision: **ready for independent review; not approved for production release**.

## Findings

### P1 - Combined-branch production rollout is still blocked

`packages/db/src/migrations/0234_good_nighthawk.sql:21` removes the legacy
`verrail_targets.project_id` column. G2.2 migration 0238 is additive, but this
combined delivery branch still requires an approved expand/contract sequence or
a stopped-write maintenance window with a current backup before production use.

### P2 - Executor identity is a local HostTrusted boundary

`server/src/routes/targets.ts:224` requires `X-Verrail-Executor-Id`, and the Go
domain verifies that this service Principal owns the Attempt. The header is
accepted only behind the board-authenticated local server facade; it is not a
remote Runner credential or transport-authentication protocol. G3 must replace
this boundary before private or untrusted remote execution claims are valid.

### P2 - Live Temporal worker restart was not exercised

`services/domain-api/internal/orchestration/workflow.go:107` implements the stable
RunWorkflow, replay-safe state, signal deduplication, and Continue-As-New. Unit
and dispatcher tests pass, but this acceptance did not run an external Temporal
service and deliberately kill and restart a worker during an active Attempt.
That operational acceptance remains evidence to collect before production use.

### P2 - Runtime acceptance cannot yet close the Target

The live G2.2 Target remains `draft` in Define because product-native Artifact,
Evidence, DeliveryReview, and Acceptance write commands are not implemented. The
repository receipt and browser evidence are inspectable, but they do not grant
acceptance authority or move the runtime Target to an accepted state.

## Verified In G2.2

- RunAttempt identity fixes the Run, DeploymentRevision, AgentVersion,
  RuntimeProfile, executor service Principal, and monotonically increasing fence.
- Serializable command receipts make mutation retry idempotent and reject a reused
  key with different content.
- One active lease is enforced per Run; expiry and supersession permit recovery
  while old fences cannot advance authoritative state.
- RunEvent cursors accept the exact next event, replay exact duplicates, reject
  conflicts and gaps, and preserve rejected callbacks in the audit trail.
- Success, failure, and observable cancellation converge RunAttempt, lease, Run,
  and WorkNode through domain commands.
- Stable RunWorkflow routing, versioned signals, deduplication, phase projection,
  and Continue-As-New are covered by passing Go tests.
- The Runs UI exposes start, retry, cancel, Attempt, lease, fence, cursor, and
  error state. Browser fault acceptance passed end to end on the migrated stack.
- Typecheck, build, Go tests, focused integration tests, migration checks, token
  gates, browser acceptance, and formatting checks passed. The only full-suite
  failures were unrelated concurrency-sensitive port tests that passed serially.

## Review Boundary

No P0 or G2.2-specific P1 defect blocks independent review. This is a self-review
and cannot satisfy independent approval, product acceptance, merge, deployment,
release, or ship authority.
