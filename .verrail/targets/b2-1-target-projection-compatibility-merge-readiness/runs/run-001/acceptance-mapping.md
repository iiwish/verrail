# B2.1 Acceptance Mapping

| Criterion | Evidence | Result |
| --- | --- | --- |
| Strict runtime parsing before authorization and serialization | `targetReadModelV1Schema`, `parseStoredTargetReadModelV1`, and every persisted read in `target-read-model.ts` | Passed |
| Bounded legacy compatibility upgrade without read mutation | Shared legacy parser, database test, manual legacy read, and unchanged old revision followed by explicit reconcile | Passed |
| Relational identity checks and stable detail errors | Service integrity checks plus corrupt and mismatched snapshot tests | Passed |
| Corrupt entry cannot take lists down | Real database test and manual Workspace/Project list proof returned 200 with valid items | Passed |
| Administrator reconciliation advances to canonical shape | Real database regression and manual revision `42faea57` to `06476226` proof | Passed |
| Regression coverage | Nine focused files and 47 tests passed | Passed |
| Critical browser workflow | Home, Project Targets, creation, compatibility/native Workbench, corrupt error, and eight tabs passed on one dataset | Passed with narrow-capture gap |
| UI to Go to outbox to Temporal on one database | Target `96835862`, outbox `550885ae`, Workflow query `acceptedEventCount=1` | Passed |
| Merge-readiness checks recorded truthfully | Go, typecheck, token gates, build, and diff passed; full Vitest recorded 30 inherited/environment failures | Passed as assessment; merge remains gated |

## Merge Decision

The B2.1 implementation is complete and the focused product path is healthy. The combined branch is not approved for direct merge in this self-review. An independent reviewer must inspect the broad uncommitted B2/B2.1/B3 change set, the commits should be split into reviewable slices, and `pnpm test:run` must be rerun on a clean host to restore or improve the inherited 24-failure baseline.
