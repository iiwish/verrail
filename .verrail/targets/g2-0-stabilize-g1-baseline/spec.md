# G2.0 - Stabilize G1 Delivery Baseline

## Objective

Establish a reproducible, reviewable, migration-safe G1 baseline before any G2
delivery capability is added.

## Scope

- Reproduce the complete repository verification result from the current G1
  branch.
- Fix failures caused by the G1 implementation.
- Classify any unrelated failures with deterministic reproduction, ownership,
  and an explicit maintainer disposition.
- Verify fresh migration and existing-database upgrade paths.
- Document the supported rollback and compatibility boundary as the current
  canonical architecture.
- Review the full G1 diff for domain authority, workspace isolation,
  transactions, idempotency, orchestration recovery, and UX regressions.

## Constraints

- Preserve all pre-existing worktree changes.
- Do not add G2.1 or later domain capability.
- Native Target, Graph, and Run facts remain separate from inherited Project,
  Issue, Heartbeat, Artifact, and compatibility run facts.
- Self-review can prepare a review package but cannot grant independent
  approval or ship authority.

## Acceptance

Acceptance is defined by `target.json`. Verification evidence must distinguish
fixed failures, accepted repository baselines, and unresolved blockers. A green
focused suite alone is insufficient when the complete repository suite remains
unexplained.
