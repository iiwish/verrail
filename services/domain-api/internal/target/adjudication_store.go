package target

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

func (store *Store) CreateSubmission(ctx context.Context, command AgentLifecycleCommand[CreateSubmissionInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertAssuranceTarget(ctx, tx, command.WorkspaceID, command.Input.TargetID); err != nil {
		return AgentLifecycleResult{}, err
	}
	var revisionTargetID string
	if err := tx.QueryRow(ctx, `select target_id from verrail_target_revisions where id=$1 and workspace_id=$2`, command.Input.TargetRevisionID, command.WorkspaceID).Scan(&revisionTargetID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, adjudicationNotFound("TargetRevision")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if revisionTargetID != command.Input.TargetID {
		return AgentLifecycleResult{}, validation("TargetRevision does not belong to the Target")
	}
	// Every artifact revision must exist in the workspace and belong to the
	// target (through its Artifact).
	var artifactCount int
	if err := tx.QueryRow(ctx, `
		select count(*) from verrail_artifact_revisions revision
		join verrail_artifacts artifact on artifact.id = revision.artifact_id and artifact.workspace_id = revision.workspace_id
		where revision.workspace_id=$1 and revision.id = any($2::uuid[]) and artifact.target_id=$3
	`, command.WorkspaceID, command.Input.ArtifactRevisionIDs, command.Input.TargetID).Scan(&artifactCount); err != nil {
		return AgentLifecycleResult{}, err
	}
	if artifactCount != len(command.Input.ArtifactRevisionIDs) {
		return AgentLifecycleResult{}, adjudicationNotFound("ArtifactRevision")
	}
	// G2.3 review follow-up: every verification result must exist in the
	// workspace and its claim must belong to the submitted TargetRevision.
	var resultCount int
	if err := tx.QueryRow(ctx, `
		select count(*) from verrail_verification_results result
		join verrail_claims claim on claim.id = result.claim_id and claim.workspace_id = result.workspace_id
		where result.workspace_id=$1 and result.id = any($2::uuid[]) and claim.target_revision_id=$3
	`, command.WorkspaceID, command.Input.VerificationResultIDs, command.Input.TargetRevisionID).Scan(&resultCount); err != nil {
		return AgentLifecycleResult{}, err
	}
	if resultCount != len(command.Input.VerificationResultIDs) {
		return AgentLifecycleResult{}, adjudicationNotFound("VerificationResult")
	}
	submissionHash, err := submissionHash(command.Input.TargetRevisionID, command.Input.ArtifactRevisionIDs, command.Input.VerificationResultIDs, command.Input.CommitRef, command.Input.EnvironmentSummary)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	// Content-addressed (Publish pattern): the same binding submitted again
	// replays the existing submission instead of creating a second candidate.
	var existingSubmissionID string
	err = tx.QueryRow(ctx, `select id from verrail_submissions where target_id=$1 and submission_hash=$2`, command.Input.TargetID, submissionHash).Scan(&existingSubmissionID)
	if err == nil {
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: adjudicationResourceSubmission, ResourceID: existingSubmissionID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, adjudicationSubmissionCreatedEvent); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, err
	}
	submissionID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_submissions(id,workspace_id,target_id,target_revision_id,artifact_revision_ids,verification_result_ids,commit_ref,environment_summary,notes,submission_hash,submitted_by_principal_type,submitted_by_principal_id) values($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7,$8,$9,$10,'user',$11)`, submissionID, command.WorkspaceID, command.Input.TargetID, command.Input.TargetRevisionID, command.Input.ArtifactRevisionIDs, command.Input.VerificationResultIDs, command.Input.CommitRef, command.Input.EnvironmentSummary, command.Input.Notes, submissionHash, command.Principal.ID); err != nil {
		if assuranceUniqueViolation(err, "verrail_submissions_target_hash_uq") {
			return AgentLifecycleResult{}, &Error{Status: 409, Code: "ADJUDICATION_SUBMISSION_DUPLICATE", Message: "An identical Submission already exists for this Target"}
		}
		return AgentLifecycleResult{}, fmt.Errorf("insert Submission: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: adjudicationResourceSubmission, ResourceID: submissionID}
	if err := finishAgentCommand(ctx, tx, meta, result, adjudicationSubmissionCreatedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) RecordDeliveryReview(ctx context.Context, command AgentLifecycleCommand[RecordDeliveryReviewInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var submissionTargetID, submitterType, submitterID string
	if err := tx.QueryRow(ctx, `select target_id,submitted_by_principal_type,submitted_by_principal_id from verrail_submissions where id=$1 and workspace_id=$2 for update`, command.Input.SubmissionID, command.WorkspaceID).Scan(&submissionTargetID, &submitterType, &submitterID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, adjudicationNotFound("Submission")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	// Authority rule (spec.md product contract item 2): the reviewer is the
	// authenticated human member recording the review — the wire field must
	// equal the command principal so independence cannot be self-attested on
	// behalf of someone else. The reviewer must also differ from the
	// submission's submitter when that submitter is a user.
	if command.Input.ReviewerPrincipalID != command.Principal.ID {
		return AgentLifecycleResult{}, forbidden("ADJUDICATION_REVIEWER_FORBIDDEN", "The reviewer must be the authenticated member recording the review")
	}
	if submitterType == "user" && submitterID == command.Input.ReviewerPrincipalID {
		return AgentLifecycleResult{}, &Error{Status: 403, Code: "ADJUDICATION_REVIEWER_NOT_INDEPENDENT", Message: "The reviewer must differ from the submission's submitter"}
	}
	reviewHash, err := deliveryReviewHash(command.Input.SubmissionID, command.Input.ReviewerPrincipalType, command.Input.ReviewerPrincipalID, command.Input.Verdict, command.Input.Risks, command.Input.UnprovenItems, command.Input.Comments)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	reviewID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_delivery_reviews(id,workspace_id,target_id,submission_id,reviewer_principal_type,reviewer_principal_id,verdict,risks,unproven_items,comments,review_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11)`, reviewID, command.WorkspaceID, submissionTargetID, command.Input.SubmissionID, command.Input.ReviewerPrincipalType, command.Input.ReviewerPrincipalID, command.Input.Verdict, command.Input.Risks, command.Input.UnprovenItems, command.Input.Comments, reviewHash); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert DeliveryReview: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: adjudicationResourceDeliveryReview, ResourceID: reviewID}
	if err := finishAgentCommand(ctx, tx, meta, result, adjudicationReviewRecordedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) AcceptSubmission(ctx context.Context, command AgentLifecycleCommand[AcceptSubmissionInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var targetID, targetRevisionID string
	if err := tx.QueryRow(ctx, `select target_id,target_revision_id from verrail_submissions where id=$1 and workspace_id=$2 for update`, command.Input.SubmissionID, command.WorkspaceID).Scan(&targetID, &targetRevisionID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, adjudicationNotFound("Submission")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	var reviewSubmissionID, reviewVerdict string
	if err := tx.QueryRow(ctx, `select submission_id,verdict from verrail_delivery_reviews where id=$1 and workspace_id=$2`, command.Input.ReviewID, command.WorkspaceID).Scan(&reviewSubmissionID, &reviewVerdict); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, adjudicationNotFound("DeliveryReview")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	// Acceptance settles a submission through an approved review of exactly
	// that submission; the latest review must also be approved so a later
	// changes_requested/rejected review blocks settlement (409).
	if reviewSubmissionID != command.Input.SubmissionID || reviewVerdict != "approved" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "ADJUDICATION_REVIEW_NOT_APPROVED", Message: "Acceptance requires an approved DeliveryReview of this Submission"}
	}
	var latestVerdict string
	if err := tx.QueryRow(ctx, `select verdict from verrail_delivery_reviews where submission_id=$1 order by created_at desc, id desc limit 1`, command.Input.SubmissionID).Scan(&latestVerdict); err != nil {
		return AgentLifecycleResult{}, err
	}
	if latestVerdict != "approved" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "ADJUDICATION_REVIEW_NOT_APPROVED", Message: "The latest DeliveryReview for this Submission is not approved"}
	}
	// AcceptanceAuthority (ontology section 5): the accepting principal must
	// be the user outcome owner of the target revision.
	var ownerType, ownerID string
	if err := tx.QueryRow(ctx, `select outcome_owner_principal_type,outcome_owner_principal_id from verrail_target_revisions where id=$1 and workspace_id=$2`, targetRevisionID, command.WorkspaceID).Scan(&ownerType, &ownerID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("read TargetRevision outcome owner: %w", err)
	}
	if ownerType != "user" || ownerID != command.Principal.ID {
		return AgentLifecycleResult{}, &Error{Status: 403, Code: "ADJUDICATION_NOT_OUTCOME_OWNER", Message: "Only the TargetRevision outcome owner can accept a Submission"}
	}
	// One acceptance per submission (unique (submission_id)): a replayed
	// acceptance returns the existing acceptance id.
	var existingAcceptanceID string
	err = tx.QueryRow(ctx, `select id from verrail_acceptances where submission_id=$1`, command.Input.SubmissionID).Scan(&existingAcceptanceID)
	if err == nil {
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: adjudicationResourceAcceptance, ResourceID: existingAcceptanceID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, adjudicationAcceptanceCreatedEvent); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, err
	}
	acceptanceHash, err := acceptanceHash(command.Input.SubmissionID, command.Input.ReviewID, targetRevisionID, adjudicationAuthorityOutcomeOwner)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	acceptanceID, _ := NewUUID()
	// on conflict do nothing keeps the transaction usable if a concurrent
	// acceptance won the race; the row is then read back as a replay.
	var insertedID string
	err = tx.QueryRow(ctx, `insert into verrail_acceptances(id,workspace_id,target_id,target_revision_id,submission_id,review_id,authority,accepted_by_principal_type,accepted_by_principal_id,acceptance_hash) values($1,$2,$3,$4,$5,$6,$7,'user',$8,$9) on conflict (submission_id) do nothing returning id`, acceptanceID, command.WorkspaceID, targetID, targetRevisionID, command.Input.SubmissionID, command.Input.ReviewID, adjudicationAuthorityOutcomeOwner, command.Principal.ID, acceptanceHash).Scan(&insertedID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.QueryRow(ctx, `select id from verrail_acceptances where submission_id=$1`, command.Input.SubmissionID).Scan(&insertedID); err != nil {
			return AgentLifecycleResult{}, err
		}
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: adjudicationResourceAcceptance, ResourceID: insertedID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, adjudicationAcceptanceCreatedEvent); err != nil {
			return result, err
		}
		return result, nil
	}
	if err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert Acceptance: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: adjudicationResourceAcceptance, ResourceID: insertedID}
	if err := finishAgentCommand(ctx, tx, meta, result, adjudicationAcceptanceCreatedEvent); err != nil {
		return result, err
	}
	return result, nil
}
