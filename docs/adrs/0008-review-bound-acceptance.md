# ADR-0008: Review-bound append-only Acceptance

Status: Accepted technical recovery decision

Date: 2026-09-06

Authority: G2.7 project administrator authorization for T035-A002. This decision does not grant an Agent human Review, ActionApproval, or Acceptance authority.

## Context

Acceptance is an immutable decision over one exact DeliveryReview and Submission. The latest Review governs current validity, so a second approved Review invalidates an Acceptance bound to the first Review. The inherited G2.4 `unique(submission_id)` storage restriction prevents the Outcome Owner from accepting the second Review. Content-addressed Submission replay is not an appropriate recovery mechanism: identical content must not be disguised as changed content merely to record another human decision.

## Decision

Acceptance is append-only and unique by `(submission_id, review_id)`. A new, authenticated Outcome Owner command may accept the latest approved Review of the same still-current Submission. It creates a new Acceptance without modifying the earlier Review, Acceptance, Submission, content hash, or command receipt. Repeated acceptance of the same Submission/Review pair remains idempotent.

This replaces only the inherited one-Acceptance-per-Submission storage restriction. The authority, independent Review requirement, exact version binding, current proof requirements and separation from ActionApproval remain unchanged. A rejected or superseded Review cannot be accepted; an old Acceptance cannot satisfy a new Review.

All readers resolve the current Acceptance using the latest Submission and latest approved Review, together with current TargetRevision, GraphRevision, ArtifactRevision and VerificationResult bindings. Historical Acceptances remain visible as invalid for the current candidate. Graph reconciliation and external Effect execution share this validity rule.

## Migration and Recovery

The forward migration adds the new pair uniqueness constraint and removes the more restrictive legacy single-column uniqueness constraint. No fact rows or historical hashes are changed or deleted. Existing rows satisfy the pair constraint automatically.

After a second Acceptance for a Submission exists, applications requiring the legacy single-row cardinality cannot be rolled back independently. Stop new adjudication commands and deploy a compatible TypeScript/Go pair or fix forward; do not delete later human decisions or restore the old uniqueness constraint over conflicting facts.

## Verification

An isolated default delivery graph covers `S/R1/A1 -> R2 -> A2`, keeps A1 immutable, rejects R1 as stale, replays S/R2 idempotently and re-settles the AcceptanceGate from A2. Read-model tests preserve A1 as invalid while selecting A2 for current validity and Outcome. Existing human authorization, self-review, self-approval and Effect parameter-binding tests remain required.
