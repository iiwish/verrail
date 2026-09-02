# G2.0 Maintainer Review

Decision: **ready for independent review; not approved for production release**.

## Findings

### P1 - Production rolling upgrade remains blocked

`packages/db/src/migrations/0234_good_nighthawk.sql:21` removes
`verrail_targets.project_id`. A pre-G1 service therefore cannot safely run against a
post-G1 database. `docs/architecture.md:252` defines the supported development and
controlled-acceptance boundary, and `docs/architecture.md:259` defines backup restore
and forward-repair behavior. This is not a blocker for the G2 development baseline,
but it is a release blocker until an expand/contract sequence or stopped-write
maintenance window is approved and rehearsed.

### P2 - Native execution identity is not yet version-bound

`services/domain-api/internal/target/graph_store.go:73` stores a responsible principal
from command input, and `services/domain-api/internal/target/graph_store.go:241` stores
the Run actor. Validation in `services/domain-api/internal/target/graph.go:215` checks
only principal kind and presence. G2.1 must resolve these identities against the
workspace's versioned AgentDefinition and Deployment facts before activation or Run
creation.

### P2 - Converting drafts lack an administrative recovery path

`server/src/services/conversation-target-drafts.ts:306` reserves a converting or
converted draft to its original confirming principal. Same-principal retries resume
at line 327, but an unavailable principal can leave the draft without an authorized
operator recovery command. The current retry behavior is deterministic and does not
corrupt facts; a governed takeover or cancel command should be added in a later
target.

## Resolved In G2.0

- Repository tests no longer depend on a case-insensitive skill manifest lookup,
  unstable macOS port ownership output, or aliased temporary roots.
- DB migration history tolerates an already-applied constraint drop, and JavaScript
  backup fallback produces portable restore SQL.
- Verrail navigation keeps inherited Projects separate from native Targets.
- Platform and installed-CLI integration tests advertise their real prerequisites,
  while OpenCode staging tests have explicit full-suite time budgets.
- Fresh and base-commit upgrade probes both reach the same 234-migration, 16-table
  native schema.

## Review Boundary

No P0 or P1 defect blocks use of G1 as the G2 development baseline. This review is a
self-review and cannot satisfy independent approval, product acceptance, merge,
deployment, release, or ship authority.
