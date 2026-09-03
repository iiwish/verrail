# G2.4 - Submission, DeliveryReview, and Acceptance

## Objective

Complete the adjudication half of the trusted delivery loop (ontology lines
147-153): an immutable Submission proposes claims per criterion, an
independent DeliveryReview records the reviewer conclusion, and the outcome
owner's Acceptance settles the target — with old acceptance automatically
invalidated when facts change (invariant 10).

## Product contract (confirmed with the Outcome Owner before this target)

1. Stage template stays define/execute/verify/accept (already in schema).
2. Authority model for G2: reviewer = any human workspace member who is NOT
   the submission submitter; acceptance authority = the target revision's
   outcomeOwner principal. Fine-grained RBAC stays in G4.
3. Submission binding = set snapshot: artifact revision ids + verification
   result ids + hashes, locked by a submission hash.

## Ontology bindings

- Submission: immutable candidate binding TargetRevision + ArtifactRevision
  set + VerificationResult set + commit/external snapshot + submitter
  (ontology 147-149). Material changes require a NEW submission.
- DeliveryReview: binds a Submission; risks, unproven items, comments,
  reviewer conclusion (151).
- Acceptance: binds DeliveryReview + Submission + TargetRevision +
  AcceptanceAuthority; new Submission or TargetRevision does not inherit old
  Acceptance (153, 262).
- Invariant 9: submission/review/acceptance facts bind content or object
  hashes. Invariant 4: submitted facts are never modified in place.

## Design

New schema file `packages/db/src/schema/verrail_adjudication.ts` + migration
0240 (statement-reconcilable DDL only):

- `verrail_submissions`: id, workspace_id, target_id, target_revision_id
  (composite workspace FK), artifact_revision_ids uuid[] (non-empty, checked
  against same-workspace revisions), verification_result_ids uuid[] (may be
  empty), commit_ref text nullable, environment_summary text nullable,
  submission_hash (sha256 over canonical payload), notes text nullable,
  submitted_by_principal_type/id, created_at. Immutable. Unique
  (target_id, submission_hash).
- `verrail_delivery_reviews`: id, workspace_id, target_id, submission_id
  (composite workspace FK), reviewer_principal_type/id, verdict
  (approved | changes_requested | rejected), risks text nullable,
  unproven_items text[], comments text nullable, review_hash (sha256 over
  canonical payload), created_at. Immutable, append-only.
- `verrail_acceptances`: id, workspace_id, target_id, target_revision_id
  (composite workspace FK), submission_id (composite workspace FK),
  review_id (composite workspace FK, must be an approved review of that
  submission), authority text ('outcome_owner' check), accepted_by_principal_type/id,
  acceptance_hash (sha256 over canonical payload), created_at. Immutable.
  Unique (submission_id) — one acceptance per submission.

Go Domain API commands (receipt + audit pattern; no outbox in this slice):

- CreateSubmission: validate target revision exists in workspace and is the
  target's revision; validate every artifact revision id and verification
  result id exists in the same workspace; artifact revisions must belong to
  the target; verification results must belong to claims of that target
  revision; submission_hash = sha256 over canonical payload {targetRevisionId,
  sorted artifactRevisionIds, sorted verificationResultIds, commitRef,
  environmentSummary}; unique (target_id, submission_hash) dedup replays the
  existing submission.
- RecordDeliveryReview: reviewer must be a human workspace member; reviewer
  principal must differ from the submission's submitter (403
  ADJUDICATION_REVIEWER_NOT_INDEPENDENT); review_hash = sha256 over canonical
  payload; append-only.
- AcceptSubmission: requires an approved review of that submission (latest
  review verdict approved; a rejected/changes-requested review blocks with
  409); requires command principal == target revision outcomeOwner (user
  type) — 403 ADJUDICATION_NOT_OUTCOME_OWNER otherwise; one acceptance per
  submission (dedup replays).

Derived validity (read model, no mutation): an acceptance is `valid` iff its
submission is the latest submission for the target AND its target_revision_id
equals the target's active revision; otherwise `invalid` with a reason
(superseded_submission | target_revision_changed). Rejections: a submission
whose latest review is rejected/changes_requested renders as `rejected`.

Read model: workspace() gains submissions (with reviews, acceptance, derived
validity/status) grouped newest-first; the Submission and Acceptance
Workbench tabs render them; the Acceptance tab surfaces invalid acceptances
with their reason. New i18n keys en + zh-CN.

Authority mapping note: in local_trusted the board actor is local-board; the
outcome owner principal recorded on the target revision must match the
accepting principal.

## Verification plan

- `pnpm db:generate` no-op; fresh-DB probe applies 0239+0240.
- Go: unit tests (hash canonicality, reviewer independence, owner authority,
  approved-review requirement) + DB-gated integration covering the full path:
  artifact -> revision -> claim -> evidence -> verification -> submission ->
  independent review (approved) -> acceptance by owner; plus rejections:
  reviewer==submitter 403, non-owner accept 403, accept without approved
  review 409, superseded submission -> derived invalid, changed active
  revision -> derived invalid.
- Facade + read model + UI tests; token gates; i18n parity; root pipeline.
