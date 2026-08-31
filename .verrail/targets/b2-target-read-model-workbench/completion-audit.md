# B2 Completion Audit

Audited at: 2026-08-26T12:12:35Z

## Result

The full active B2 objective is not complete.

The TargetReadModel, compatibility mapping, read APIs, authorization, audit,
Project entry points, and read-only Workbench are implemented and evidenced.
The governed New Target command, authoritative Target and TargetRevision
persistence, and creation experience are not implemented.

## Requirement Evidence

| Requirement | Evidence | Assessment |
| --- | --- | --- |
| TargetReadModel database and shared contracts | Migration 0228, shared Target types, projection service, focused integration tests | Proven |
| Compatibility mapping and reconciliation | Admin-only routes, eligibility checks, local Activity records, replay tests | Proven |
| Authorized list, detail, and immutable revision APIs | Route tests, OpenAPI parity, current-source authorization, cursor and ETag tests | Proven |
| UI entry points and Target details | Home, Project Target list, Workbench routes, desktop/mobile screenshots | Proven |
| Existing Project and Issue compatibility | Feature-flag fallback, no changed compatibility writes, focused route tests | Proven |
| Governed New Target command | No command endpoint or authoritative aggregate exists | Missing |
| Authoritative Target and TargetRevision persistence | Current tables are explicitly rebuildable compatibility projections | Missing |
| New Target creation experience | No form or successful create-to-Workbench path exists | Missing |
| Command idempotency, authorization, outbox, and atomic audit | No native command owner exists | Missing |

## Authority Conflict

The missing work cannot be implemented honestly under all current constraints:

1. ADR-0004 assigns the new Verrail Domain API and Target/TargetRevision write
   ownership to Go.
2. ADR-0004 rejects a short-lived TypeScript implementation of the new domain
   and requires one writer per aggregate.
3. docs/target-read-model.md defines the TypeScript projection as read-only
   and explicitly excludes Target and TargetRevision write APIs.
4. The active B2 objective simultaneously requires a governed New Target
   closed loop and forbids enabling Go in this stage.
5. Creating a Case or Issue and presenting it as a native Target would violate
   the confirmed ontology and the explicit compatibility boundary.

## Safe Resolution Gate

One durable authority decision is required before implementation can continue:

- authorize the first Go Domain API vertical slice for Target and
  TargetRevision, without Temporal; or
- explicitly supersede ADR-0004 and accept a temporary TypeScript native
  Target aggregate plus its later migration cost.

The recommended path is the first option. It preserves the accepted architecture
and can still defer Temporal until the Target command, idempotency, outbox,
authorization, audit, and read integration are proven.

Until that gate changes, the read-only B2 slice remains reviewable but the full
active goal must remain open.

## Resolution

Resolved at: 2026-08-26T16:09:20Z

The product owner approved the minimum Go slice. The linked
`b2-native-target-command` target implements and evidences the authoritative
native Target command, immutable first TargetRevision, idempotency, atomic audit
and outbox facts, and create-to-Workbench path. The read-only audit above remains
the historical record of the authority gate; current completion evidence lives
in the child target's `run-001` receipt, evidence, and advisory review.
