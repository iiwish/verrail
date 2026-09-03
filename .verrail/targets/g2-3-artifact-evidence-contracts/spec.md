# G2.3 - Artifact and Evidence minimal contracts

## Objective

Give the trusted delivery loop its Assurance data spine: Run output becomes
inspectable ArtifactRevisions, acceptance criteria gain immutable Evidence and
per-criterion VerificationResults, and the Workbench shows real facts instead
of honest empty sets.

## Product contract (confirmed defaults, Gate 2)

Confirmed by the Outcome Owner before this target opened:

1. Stage template stays the de facto define/execute/verify/accept order already
   encoded in the schema; no StageTemplate registry in this slice.
2. Authority model stays minimal: workspace board members record and verify;
   the five-authority split becomes binding in G2.4 (Submission/Acceptance).
3. Submission binding granularity is a set snapshot; decided with G2.4.

## Ontology bindings (docs/operational-ontology.md)

- ArtifactRevision is content-addressed and immutable; binds content hash,
  source Target, WorkNode, Run, Base Revision, and creating principal.
- Evidence is an immutable source record supporting or refuting a Claim: type,
  producing principal, object hash, time, validity, trust level, original
  reference. Agent self-reports are low-trust observations only.
- VerificationResult binds Criterion, Claim, Evidence set, and verifier
  version; verdict in passed/failed/inconclusive/waived; waived requires an
  authorized human exception reference.
- Claims belong to a TargetRevision criterion; a Submission proposes claims per
  applicable criterion (G2.4 owns the Submission binding).
- Facts must bind content or object hash (ontology invariant 9); activated
  facts are never modified in place (invariant 4).

## Design

New schema file `packages/db/src/schema/verrail_assurance.ts` + migration 0239:

- `verrail_artifacts`: id, workspace_id, target_id (composite workspace FK),
  kind (code_change | document | report | external_reference), title,
  created_by_principal_type/id, created_at/updated_at.
- `verrail_artifact_revisions`: artifact (+workspace composite FK),
  revision_number (monotonic, unique per artifact), content_hash (sha256),
  content_ref (storage pointer text), source_run_id nullable (workspace FK to
  verrail_runs), source_work_node_id nullable, base_revision_id nullable
  (self FK), created_by_principal_type/id, created_at; unique (artifact,
  content_hash).
- `verrail_claims`: id, workspace_id, target_id, target_revision_id
  (composite workspace FK), criterion_key (text; key into the target revision
  acceptanceCriteria array), title, status (open | supported | refuted |
  waived), created_by_principal_type/id, created_at/updated_at; unique
  (target_revision_id, criterion_key) for open claims.
- `verrail_evidence`: id, workspace_id, target_id, claim_id nullable
  (composite workspace FK), kind (ci_result | scan_result | human_review |
  agent_observation | external_reference), producer_principal_type/id,
  object_hash (sha256), reference (uri or object id text), trust_level
  (high | medium | low), recorded_at, created_by_principal_type/id,
  created_at; immutable (no updates).
- `verrail_verification_results`: id, workspace_id, target_id, claim_id
  (composite workspace FK), verdict (passed | failed | inconclusive | waived),
  verifier_version text, evidence_ids uuid[] (checked non-empty except for
  waived), waiver_reference text nullable (required when waived),
  result_hash (sha256 over the canonical result payload), created_by_principal_type/id,
  created_at; immutable; unique (claim_id, result_hash).

Domain commands (Go Domain API, established receipt + audit pattern, no
outbox in this slice):

- CreateArtifact, AddArtifactRevision, CreateClaim, RecordEvidence,
  RecordVerificationResult.
- AddArtifactRevision deduplicates a reused (artifact, content_hash) by
  replaying the existing revision id (content addressing: same hash is the
  same content); revision numbers allocate monotonically under the artifact
  row lock.
- RecordEvidence rejects mutation by design (insert-only).
- RecordVerificationResult validates the waiver rule (waived requires
  waiver_reference) and requires evidence_ids to reference same-workspace
  evidence rows; verdict passed/failed require at least one evidence row.
- VerificationResult marks the claim status supported/refuted/waived
  transactionally.

Read model: `target-read-model.ts` replaces the artifacts/evidence honest
empty arrays with real server facts (artifacts with revisions, evidence,
verification results grouped by claim/criterion) while keeping the honest
empty-set behavior when no facts exist.

Workbench: Artifacts and Evidence tabs render the read-model facts; existing
tests extended, i18n keys added in en + zh-CN.

## Verification plan

- Fresh migration probe + `pnpm db:generate` no-op (reconcilable DDL only: no
  DML, no same-name constraint swaps).
- Go: unit tests per command (idempotent replay, conflict rejection, waiver
  rule, trust-level handling) + integration tests gated on
  VERRAIL_TEST_DATABASE_URL following the agent-lifecycle pattern.
- Server: route tests + read-model tests updated for real facts.
- Shared validator tests; UI tests for the two tabs; token gates; i18n parity.
