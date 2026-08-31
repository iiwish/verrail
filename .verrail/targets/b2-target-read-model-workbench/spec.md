# Target Read Model And Workbench Spec

## Problem

The Verrail shell can navigate to Target-shaped routes, but it cannot yet obtain a stable Target identity or immutable TargetRevision snapshot from the server. Treating every Issue as a Target or synthesizing identifiers in the browser would collapse the confirmed domain model back into the inherited tracker.

## Goal

Deliver the first authorized, versioned, replay-safe Target read path and a useful read-only Target Workbench over explicitly approved compatibility sources.

## Authority Contract

- Case and Issue remain the compatibility write owners for this slice.
- Projection source rows and revision snapshots are rebuildable read models, not command handlers.
- The browser consumes server-issued Target and TargetRevision UUIDs as opaque identifiers.
- `accepted` is never inferred from Case approval, Case completion, Issue completion, Agent output, or projection state.
- Mapping and reconciliation are explicit instance-operator actions and are audited locally.

## API Contract

- Lists are Workspace-scoped and optionally Project-scoped.
- Cursor identity includes Workspace, Principal, filters, sort, timestamp, and Target ID.
- Detail and immutable revision reads return the same 404 for missing and inaccessible resources.
- Private ETags permit revalidation without making one Principal's projection reusable by another.
- Read requests do not create mappings, reconcile sources, or trigger external effects.

## UX Contract

- Target lists and the Workbench are available only when `enableVerrailNavigation` is enabled.
- Empty state means no eligible approved projection, not that the UI should fabricate a Target.
- Stale, missing-source, and completion-without-Acceptance states are visible and non-destructive.
- Workbench tabs may be empty, but every count and status shown must come from the server projection.
- Existing source pages remain reachable from every projected Target.

## Go Boundary

ADR-0004 assigns the future authoritative Target/TargetRevision write model to the Go Domain API. B2 therefore does not implement `New Target` by writing a Case and calling it a native Target. The New Target workflow begins only when the Go kernel slice can own the aggregate, immutable revision, idempotency, outbox, authorization, and audit contracts.

## Acceptance Criteria

The acceptance criteria in `target.json` are authoritative for this target.

## Risks

- A stored projection can become stale after its source changes; detail reads must report this rather than silently claim freshness.
- A list cursor can leak or skip objects if authorization filtering occurs after pagination.
- Case and Issue permissions differ; unsupported source authorization must fail closed.
- Compatibility aggregates lack authoritative Criterion, Evidence, Submission, and Acceptance facts; missing fields must remain explicit.

## Open Questions

- Automatic outbox-driven projection and hourly reconciliation remain part of the confirmed target architecture and should be implemented with the first Go/Temporal compatibility bridge.
- Native New Target belongs to the next Go Domain API goal, not this TypeScript read-only slice.
