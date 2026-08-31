# M0 Acceptance Mapping

1. **Covered with a formal inherited baseline.** All focused Target, Go, typecheck, build, token, launcher, Compose, and diff checks passed. The full Vitest run retained 29 failures in eight unchanged Paperclip files; current/base file-level comparisons reproduced every failure class and found no Target merge-delta regression.
2. **Covered.** A fresh PostgreSQL database applied all 229 migrations. A database created at base commit `3206490d`, seeded with company and project data, upgraded from 226 to 229 migrations without losing either row and exposed every Target table.
3. **Covered.** `pnpm dev:verrail` is the documented local entry point for PostgreSQL, Temporal, TypeScript compatibility edge/UI, the managed Go Domain API, and the separate Go orchestration worker. Shared addresses, ports, credentials, health checks, and shutdown behavior are explicit.
4. **Covered.** On one database, native Target creation committed TargetRevision, AuditEvent, and outbox facts; the worker delivered the event to the stable Workflow ID; a duplicate delivery was ignored; and a complete stack restart preserved both database and Workflow state.
5. **Covered.** Forty-seven focused tests preserve list, detail, immutable revision, native precedence, corrupt projection isolation, bounded legacy normalization, reconciliation, authorization, idempotency, and Workbench behavior.
6. **Covered.** The cumulative implementation is split into dependency-ordered Target and orchestration commits. Migration order is preserved, unrelated runtime behavior was not changed, and the delivery records form a separate final commit.
7. **Covered.** The advisory review records `needs_human_decision`. Codex does not grant final merge, release, or ship approval.

The implementation is a technically merge-ready candidate. Final merge remains an independent human decision, and production enablement remains outside M0.
