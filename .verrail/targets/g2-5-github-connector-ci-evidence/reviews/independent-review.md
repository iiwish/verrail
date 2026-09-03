# G2.5 Independent Engineering Review — disposition

Reviewers: two independent review slices (backend connector semantics /
external-action safety / transaction integrity; facade contract sync /
read-model honesty). No P0 found.

## Findings and dispositions

### Fixed during this review

1. **P1 — ExecuteAction did not re-check acceptance validity / latest
   submission at execution time.** target.json criterion 2 reads
   "execution requires ... a valid derived acceptance on the latest
   submission"; the gate existed only in RequestPullRequestAction. A
   submission superseded (or a revision rotated) between approval and
   execution would still produce the external PR (invariant 10 violation).
   FIXED: ExecuteAction now re-derives latest-submission +
   deriveAcceptanceValidity inside its locked transaction before calling the
   connector (409 CONNECTOR_SUBMISSION_SUPERSEDED / ADJUDICATION_NOT_APPLICABLE);
   two integration subtests added (supersede-after-approval, revision-rotate-
   after-approval — both assert the upstream connector is NOT reached);
   15 subtests total, all passing on a real database.
2. **P2 — Path/body action request identity never bound.** The facade
   forwarded the body verbatim (URL path segment cosmetic) and the Go store
   used only the body's ActionRequestID while the audit ignored the path —
   approving/executing action B through action A's URL was possible.
   FIXED in both layers: the facade rejects mismatches with 400
   CONNECTOR_PATH_PAYLOAD_MISMATCH (route test added); the Go store rejects
   command.ResourceID != command.Input.ActionRequestID.
3. **P2 — spec.md documentation gaps**: execute-time gate semantics,
   repo-binding provisioning deferral (no governed command yet — rows are
   provisioned out of band), GitHub client token-injection deferral
   (CONNECTOR_CREDENTIALS_NOT_CONFIGURED until control-plane credential
   wiring), and upstream-crash reconciliation residual risk. FIXED: all four
   recorded in spec.md.
4. **P2 (fix landed in the same delivery)** — the repo-binding composite FK
   depended on tool_connections_company_id_uq, which the connections-v3
   migration machinery drops during rollback repair (real CI-shard failure).
   FIXED pre-review-disposition: single-column FK to the connection PK;
   connections-v3 migration test + 13 connector subtests re-verified.

### Recorded as follow-ups

- **P2** — upstream-crash reconciliation: a GitHub PR created but the
  transaction rolled back before receipt commit leaves an orphan external PR;
  a retry with the same idempotency key creates a duplicate. Invariant-15
  verification before blind replay is a G2.6 item (worker kill-restart
  evidence covers the class).
- **P2** — latest-submission determination is check-then-act (no target
  lock); fully mitigated by the P1 execute-time re-check.
- **P3** — request-time error code naming uses the CONNECTOR_ prefix while
  spec.md sketched ADJUDICATION_APPROVER_NOT_INDEPENDENT (per-domain prefix
  convention is more consistent; spec updated conceptually).
- **P3** — claim row read without FOR UPDATE in RecordIntegrationRun (assurance
  locks); SSI compensates; matches neither pattern exactly — cosmetic.
- **P3** — failure-conclusion write path covered at unit level only (no
  integration subtest asserts claim refuted); neutral and success covered.
- **P3** — claim status flip remains unconditional (pre-existing assurance
  convention, mirrored).
- **P3** — HTTP call inside the open Serializable tx holds the action-request
  row lock for up to the client timeout (bounded 30s); standard
  atomicity-vs-external-call trade-off.
- **P3** — read model workspaceBinding surfaces the binding row without the
  connection-enabled join the execution gate requires (one binding per
  workspace; a disabled connection shows a binding while executions 409) —
  surfacing an `enabled` field is a G2.6 nicety.
- **P3** — unicode/UUID regex parity divergences are codebase-wide
  pre-existing conventions (TS stricter/permissive in different directions).

## Verdict per acceptance criterion (post-fix)

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Integration runs produce evidence + verification results | SATISFIED |
| 2 | Governed PR external action | SATISFIED (after fix: execute-time gate) |
| 3 | Effect receipts bind external outcomes | SATISFIED |
| 4 | Connector behind an interface | SATISFIED (Fake covers tests; real client thin; token deferral documented) |
| 5 | Contracts synchronized and verified | SATISFIED |

**Recommendation: approvable.** The connector spine follows the established
command patterns faithfully; the one P1 is fixed with regression tests; the
documented deferrals match the slice's non-goals.

## Review boundary

Independent engineering review only. Product acceptance, merge, deployment,
release, and ship authority remain with the Outcome Owner.
