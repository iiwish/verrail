# G2.3 Maintainer Review

Decision: **ready for independent review; not approved for production release**.

## Self-verified in this run

- Schema 0239 is statement-reconcilable (no DML, no same-name constraint swaps);
  `pnpm db:generate` is a no-op after edits; fresh-DB probe applies all 238
  migrations and creates the 5 assurance tables (31 verrail tables total).
- All five Go commands follow the established receipt + audit transaction
  pattern with advisory locking. Verified against a real throwaway PostgreSQL:
  10 integration subtests cover monotonic revision allocation, content-hash
  dedup replay, receipt replay, idempotency-key conflict, claim status flips
  (passed→supported, failed→refuted, waived→waived, inconclusive unchanged),
  the waiver rule (waived requires a waiver reference; non-waived forbids one),
  cross-workspace evidence rejection, result-hash dedup, and claim/evidence
  binding with trust levels.
- The TypeScript facade mirrors the Go routes exactly (paths, headers, response
  shape); OpenAPI coverage test passes with the new routes registered; the
  route-file registry includes assurance.ts.
- The native read model serves real assurance facts with honest empty sets;
  its test asserts only verrail_* tables are queried (no compatibility reads).
- The Workbench renders real Artifacts and Evidence facts with verdict/claim
  status tone badges from the canonical status-color map; i18n parity holds
  (en = zh-CN, 3312 keys, 26 new assurance keys); token gates clean.
- Root pipeline green except one inherited heartbeat concurrency test that
  fails under full-suite parallel load and passes in isolation — same
  adjudicated flake class as prior runs.

## Known boundaries (recorded, non-blocking)

- Assurance aggregates emit no outbox events in this slice; the Timeline reads
  assurance tables directly.
- Authority model stays minimal (board members record and verify); the
  five-authority split binds in G2.4.
- ArtifactContract registry deferred; kinds are a fixed enum.
- Claims bind criterion keys textually; drift against a changed TargetRevision
  is formalized by G2.4's submission invalidation.
- One-time incident recorded in the timeline: the stuck-converting-draft gap
  was reproduced live during target creation and recovered via direct DB
  update — evidence for the G2.6 admin recovery command.

## Review boundary

This is a self-review. It cannot satisfy independent approval, product
acceptance, merge, deployment, release, or ship authority.
