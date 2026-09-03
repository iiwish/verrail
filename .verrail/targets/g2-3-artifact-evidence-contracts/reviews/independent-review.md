# G2.3 Independent Engineering Review — disposition

Reviewers: two independent review slices (backend ontology fidelity /
transaction integrity / idempotency / workspace isolation; facade contract
sync / authz / UI honesty). No P0 found.

## Findings and dispositions

### Fixed during this review

1. **P1 — Agent-produced evidence trust level unenforced.** Ontology 141 and
   acceptance criterion 2 require agent self-reports to be low-trust
   observations; kind='ci_result' with producer='agent' at high trust was
   accepted. FIXED in all three layers: DB check constraint
   `verrail_evidence_agent_trust_check` (producer='agent' implies
   kind='agent_observation' and trust='low'), shared zod superRefine, and Go
   validation. Verified: constraint present in a live migrated database;
   validator + Go unit + integration suites green.
2. **P1 — Evidence claim/target binding mismatch unenforced.** RecordEvidence
   validated target and claim existence but not that the claim belongs to the
   given target, allowing misattributed evidence across targets within a
   workspace (user-visible in the Evidence tab). FIXED: the claim reference
   now selects target_id and rejects mismatches with a validation error;
   integration subtest "evidence claim must belong to the given target" added
   (11 subtests total, all passing on a real database).
3. **P2 — spec.md wording**: "rejects a reused (artifact, content_hash)"
   contradicted the implemented content-addressing dedup replay. FIXED: spec
   now describes the replay semantics; implementation + tests were already
   coherent.

### Recorded as follow-ups

- **P2** — Go integration tests are environment-gated and not wired into CI
  (no workflow sets VERRAIL_TEST_DATABASE_URL). To be wired before or shortly
  after merge (G2.6 operational verification).
- **P2** — shared `TargetWorkspaceV1` still declares the legacy
  artifacts/evidence shapes while the workspace endpoint returns the
  assurance shape; deliberate, documented compat override in server + UI
  until the domain migration completes. Replace the shared type at migration
  completion.
- **P2** — verification results may cite evidence attached to other claims or
  unbound evidence (same-workspace checked only). Tighten in G2.4: submission
  validation binds verification results to claims of the submitted revision.
- **P3** — claims bind criteria by key into the immutable TargetRevision
  (transitive hash binding); literal invariant-9 hash column deferred to the
  G2.4 submission hash design.
- **P3** — nil vs empty evidenceIds marshal to different request hashes;
  nil vs [] claimId does not. Cosmetic retry-semantics edge.
- **P3** — claim status transitions are unrestricted (a later passed result
  can flip a waived claim); revisit when G2.4 formalizes the claim lifecycle.

## Verdict per acceptance criterion (post-fix)

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Content-addressed immutable artifact revisions | SATISFIED |
| 2 | Immutable evidence, trust levels, agent = low-trust | SATISFIED (after fix) |
| 3 | VerificationResult binds criterion/claim/evidence set | SATISFIED |
| 4 | Go-only writes, receipt + audit pattern | SATISFIED |
| 5 | Workbench real facts / honest empty sets | SATISFIED |
| 6 | Contracts synchronized, gates pass | SATISFIED (with documented compat override) |

**Recommendation: approvable.** The transaction pattern, idempotency, and
workspace isolation follow the established agent-lifecycle conventions
faithfully; both P1s are fixed and verified against a real database.

## Review boundary

Independent engineering review only. Product acceptance, merge, deployment,
release, and ship authority remain with the Outcome Owner.
