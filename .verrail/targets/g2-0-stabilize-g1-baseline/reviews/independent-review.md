# G2.0 Independent Engineering Review — combined G1/G2.0/G2.1/G2.2 changeset

Reviewer: independent agent (Sisyphus orchestration; 4 parallel review slices + fix execution separate from the authoring agent).
Reviewed tree: uncommitted changeset vs HEAD `b307b961`, including fix batches applied during this review.
Method: 4 parallel read-only review slices (DB/migrations, Go domain API, TS server facade, UI + shared contracts) against each target's `acceptance_criteria`; findings triaged by severity; P1s fixed by separate agents and re-verified; verification re-run after fixes.

## Verification evidence (reviewer-executed)

| Gate | Result |
| --- | --- |
| `pnpm -r typecheck` | PASS (pre- and post-fix) |
| `services/domain-api`: `go vet`, `go build`, `go test ./...` | PASS (pre- and post-fix) |
| New Go integration test | PASS against a real throwaway PostgreSQL (migrations + seed applied); skips without `VERRAIL_TEST_DATABASE_URL` |
| `pnpm check:token-gates` | All 4 gates CLEAN (pre- and post-fix) |
| Repository Vitest (full) | 4425/4426 UI tests + server/shared/cli/db green; 1 concurrency flake (`AgentActionButtons.test.tsx`, passes 6/6 serially); post-fix full re-run recorded separately |
| Targeted UI tests post-fix | 14/14 (TargetWorkbench 8, VerrailAgents 3, Collections 3) |
| i18n parity | en 3286 keys = zh-CN 3286 keys, zero diff; new keys bilingual |
| Migration path | Fresh DB and base-commit upgrade both reach 234-migration/16-table native schema (recorded in run-001 evidence; reviewer re-verified `0238` snapshot chains correctly from `0236` — `0237` is data-only without snapshot, journal consistent) |

## Findings and dispositions

### Fixed during this review (were P1/P2 blockers)

1. **P1 — Evaluation surface could not record failure.** `ui/src/pages/VerrailAgents.tsx` hardcoded `status: "passed"` and `safetyStatus: "passed"`. FIXED: status/safety selectors (`passed|failed|inconclusive`, `passed|failed|not_run`), i18n'd labels, tests assert failed evaluations are recordable.
2. **P1 — Retired Deployment could be resurrected.** `ReviseDeployment` had no guard for `status == "retired"`: retire→pause→resume, upgrade, and rollback all restored `active`. FIXED: `deploymentRevisionGate` rejects every action (including repeated retire) with 409 `DEPLOYMENT_RETIRED`; unit + real-DB integration tests prove both the rejection and that non-retired states keep their previous semantics.
3. **P1 — Headline surfaces untested.** No tests for `VerrailAgents.tsx`, `Collections.tsx`, or the Workbench Runs tab. FIXED: new `VerrailAgents.test.tsx`, `Collections.test.tsx`, Runs-tab tests in `TargetWorkbench.test.tsx` (attempts/lease/fence/cursor rendering, retry/cancel command calls with executor identity, per-run pending disable, error-code surfacing, failed-evaluation recording).
4. **P2 — Untranslated English literals** in the Agents publish/eval surfaces. FIXED: wrapped in `t()` with bilingual keys (`agentLifecycle.publish.*`, `agentLifecycle.evaluation*`).
5. **P2 — Per-call idempotency keys** in `ui/src/api/agentLifecycle.ts`. FIXED: stable key per open dialog (reused across re-submits until success), fresh key per non-dialog action.
6. **P2 — Run command errors collapsed to one generic string** and retry disabled across all runs. FIXED: failure message now carries the domain error code/status (`targets.execution.commandFailedDetail`); pending state tracked per run id.
7. **P2 — Test fixture used invalid work status** `"in_progress"` (not in the shared contract enum). FIXED to `"running"`.

### Recorded as follow-up targets (not blocking the G1 development baseline)

- **DB** `verrail_targets.status` has no CHECK constraint although the ontology defines a fixed lifecycle; every other native status column is constrained. Also `verrail_runs.target_id/target_revision_id/graph_revision_id` lack FKs, inconsistent with the repo's own composite-FK discipline; projection tables (`target_projection_*`) are orphaned (export removed, tables retained).
- **Go** `CreateGraphRevision` and all agent-lifecycle commands write audit + receipt but no outbox events; `ActivateGraphRevision`'s already-active branch writes a receipt without an audit event; `CreateRun` lacks a receipt/advisory lock so a concurrent duplicate gets a 500 (unique violation) instead of a replay, and Serializable failures surface as 500 `TARGET_CREATE_FAILED`; the outbox dispatcher's per-aggregate FIFO means one permanently failed event wedges all newer events for that aggregate with no automated repair; cancelling a queued run with zero attempts returns 404; the workflow signal-dedup ring is bounded (512) and terminal phases have no regression guard.
- **TS** a permanently-failing domain rejection leaves a TargetCreationDraft stuck in `converting` with no cancel/edit path (extends the documented single-principal resume gap — needs a governed admin recovery command); authz-negative route tests (404 masking, principal-bound cursor, viewer-write rejection, agent rejection) were deleted with the old projection code and not re-homed at the TS layer (domain-side negatives are covered by the Go integration test); draft create/update/cancel and target-creation mutations write no activity-log entries (draft cancel has no audit trail at all).
- **UI** target lists fetch `limit 100/50` with no truncation indicator; abandoned drafts are never cancelled (server endpoint unused).

### Adjudicated environment items

- `AgentActionButtons.test.tsx` "Clear error" — fails only under full-suite parallel load, passes serially and in isolation (6/6). Same class as the g2-0 resolved concurrency issues; disposition: environment flake, re-run evidence recorded with this review.
- `X-Verrail-Executor-Id` local-facade boundary (per g2-2 review) — confirmed contained: only `targets.ts:224` accepts it; the Go domain rejects identity mismatch (403 `EXECUTOR_IDENTITY_MISMATCH`) and stale fencing (non-authoritative 202). Trust anchor is the shared bearer token of the local facade; G3 must replace it.

## Verdict per target

- **g1-domain-closure**: SATISFIED. Native-only read model and Workbench facts (grep-verified: no compat table reads), honest empty sets, deterministic draft confirm (`conversionIdempotencyKey` + `expectedRevisionNumber`), concurrent-confirm race safe, 404-masking preserved.
- **g2-1-versioned-agent-lifecycle**: SATISFIED post-fix. Content-addressed AgentVersion with unique (definition, hash)/(definition, number); unique default per workspace; evaluation gates deployment; identity resolves to active DeploymentRevision + fixed AgentVersion at graph and run time; retired is now terminal.
- **g2-2-recoverable-run-execution**: SATISFIED post-fix. Runs UI exposes start/retry/cancel, attempt identity, lease, fencing, cursor, error state from server facts only; DB-level uniques back fence/lease/cursor/receipt claims; success/failure/cancellation converge through domain commands.

No P0 findings. Both P1 findings are fixed and re-verified. The recorded P2 follow-ups do not breach the cited acceptance criteria for the development baseline. **Recommendation: ready for user acceptance of the combined changeset as the G1 closeout baseline; production rollout remains blocked by the already-adjudicated migration 0234 expand/contract requirement.**

## Review boundary

This is an independent engineering review. It does not by itself grant product acceptance, merge, deployment, release, or ship authority; those remain with the Outcome Owner.
