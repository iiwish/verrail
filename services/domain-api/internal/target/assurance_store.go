package target

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func assertAssuranceTarget(ctx context.Context, tx pgx.Tx, workspaceID, targetID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from verrail_targets where id=$1 and workspace_id=$2)`, targetID, workspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return assuranceNotFound("Target")
	}
	return nil
}

// assertAssuranceReference validates that an optional reference points at an
// existing row in the same workspace. The table name comes only from fixed
// literals at the call sites, never from command input.
func assertAssuranceReference(ctx context.Context, tx pgx.Tx, workspaceID string, id *string, table string, label string) error {
	if id == nil {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from `+table+` where id=$1 and workspace_id=$2)`, *id, workspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return assuranceNotFound(label)
	}
	return nil
}

func assuranceUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}

func (store *Store) CreateArtifact(ctx context.Context, command AgentLifecycleCommand[CreateArtifactInput]) (AgentLifecycleResult, error) {
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
	id, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_artifacts(id,workspace_id,target_id,kind,title,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,'user',$6)`, id, command.WorkspaceID, command.Input.TargetID, command.Input.Kind, command.Input.Title, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert Artifact: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: assuranceResourceArtifact, ResourceID: id}
	if err := finishAgentCommand(ctx, tx, meta, result, assuranceArtifactCreatedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) AddArtifactRevision(ctx context.Context, command AgentLifecycleCommand[AddArtifactRevisionInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var artifactID string
	if err := tx.QueryRow(ctx, `select id from verrail_artifacts where id=$1 and workspace_id=$2 for update`, command.Input.ArtifactID, command.WorkspaceID).Scan(&artifactID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, assuranceNotFound("Artifact")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	var existingRevisionID string
	err = tx.QueryRow(ctx, `select id from verrail_artifact_revisions where artifact_id=$1 and content_hash=$2`, command.Input.ArtifactID, command.Input.ContentHash).Scan(&existingRevisionID)
	if err == nil {
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: assuranceResourceArtifactRevision, ResourceID: existingRevisionID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, assuranceArtifactRevisionAddedEvent); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, err
	}
	if err := assertAssuranceReference(ctx, tx, command.WorkspaceID, command.Input.SourceRunID, "verrail_runs", "Run"); err != nil {
		return AgentLifecycleResult{}, err
	}
	if err := assertAssuranceReference(ctx, tx, command.WorkspaceID, command.Input.SourceWorkNodeID, "verrail_work_nodes", "WorkNode"); err != nil {
		return AgentLifecycleResult{}, err
	}
	if err := assertAssuranceReference(ctx, tx, command.WorkspaceID, command.Input.BaseRevisionID, "verrail_artifact_revisions", "ArtifactRevision"); err != nil {
		return AgentLifecycleResult{}, err
	}
	var revisionNumber int
	if err := tx.QueryRow(ctx, `select coalesce(max(revision_number),0)+1 from verrail_artifact_revisions where artifact_id=$1`, command.Input.ArtifactID).Scan(&revisionNumber); err != nil {
		return AgentLifecycleResult{}, err
	}
	revisionID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_artifact_revisions(id,workspace_id,artifact_id,revision_number,content_hash,content_ref,source_run_id,source_work_node_id,base_revision_id,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'user',$10)`, revisionID, command.WorkspaceID, command.Input.ArtifactID, revisionNumber, command.Input.ContentHash, command.Input.ContentRef, command.Input.SourceRunID, command.Input.SourceWorkNodeID, command.Input.BaseRevisionID, command.Principal.ID); err != nil {
		if assuranceUniqueViolation(err, "verrail_artifact_revisions_artifact_hash_uq") {
			return AgentLifecycleResult{}, &Error{Status: 409, Code: "ARTIFACT_REVISION_DUPLICATE", Message: "An ArtifactRevision with this content hash already exists for the Artifact"}
		}
		return AgentLifecycleResult{}, fmt.Errorf("insert ArtifactRevision: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: assuranceResourceArtifactRevision, ResourceID: revisionID}
	if err := finishAgentCommand(ctx, tx, meta, result, assuranceArtifactRevisionAddedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) CreateClaim(ctx context.Context, command AgentLifecycleCommand[CreateClaimInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var revisionTargetID string
	if err := tx.QueryRow(ctx, `select target_id from verrail_target_revisions where id=$1 and workspace_id=$2`, command.Input.TargetRevisionID, command.WorkspaceID).Scan(&revisionTargetID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, assuranceNotFound("TargetRevision")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if revisionTargetID != command.Input.TargetID {
		return AgentLifecycleResult{}, validation("TargetRevision does not belong to the Target")
	}
	claimID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_claims(id,workspace_id,target_id,target_revision_id,criterion_key,title,status,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,'open','user',$7)`, claimID, command.WorkspaceID, command.Input.TargetID, command.Input.TargetRevisionID, command.Input.CriterionKey, command.Input.Title, command.Principal.ID); err != nil {
		if assuranceUniqueViolation(err, "verrail_claims_target_revision_criterion_open_uq") {
			return AgentLifecycleResult{}, &Error{Status: 409, Code: "CLAIM_CRITERION_DUPLICATE", Message: "An open Claim already exists for this acceptance criterion"}
		}
		return AgentLifecycleResult{}, fmt.Errorf("insert Claim: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: assuranceResourceClaim, ResourceID: claimID}
	if err := finishAgentCommand(ctx, tx, meta, result, assuranceClaimCreatedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) RecordEvidence(ctx context.Context, command AgentLifecycleCommand[RecordEvidenceInput]) (AgentLifecycleResult, error) {
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
	if command.Input.ClaimID != nil {
		var claimTargetID string
		if err := tx.QueryRow(ctx, `select target_id from verrail_claims where id=$1 and workspace_id=$2`, *command.Input.ClaimID, command.WorkspaceID).Scan(&claimTargetID); errors.Is(err, pgx.ErrNoRows) {
			return AgentLifecycleResult{}, assuranceNotFound("Claim")
		} else if err != nil {
			return AgentLifecycleResult{}, err
		}
		if claimTargetID != command.Input.TargetID {
			return AgentLifecycleResult{}, validation("Evidence claim does not belong to the given Target")
		}
	}
	evidenceID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_evidence(id,workspace_id,target_id,claim_id,kind,producer_principal_type,producer_principal_id,object_hash,reference,trust_level,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user',$11)`, evidenceID, command.WorkspaceID, command.Input.TargetID, command.Input.ClaimID, command.Input.Kind, command.Input.ProducerPrincipalType, command.Input.ProducerPrincipalID, command.Input.ObjectHash, command.Input.Reference, command.Input.TrustLevel, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert Evidence: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: assuranceResourceEvidence, ResourceID: evidenceID}
	if err := finishAgentCommand(ctx, tx, meta, result, assuranceEvidenceRecordedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) RecordVerificationResult(ctx context.Context, command AgentLifecycleCommand[RecordVerificationResultInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimTargetID string
	if err := tx.QueryRow(ctx, `select target_id from verrail_claims where id=$1 and workspace_id=$2 for update`, command.Input.ClaimID, command.WorkspaceID).Scan(&claimTargetID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, assuranceNotFound("Claim")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	var evidenceCount int
	if err := tx.QueryRow(ctx, `select count(*) from verrail_evidence where workspace_id=$1 and id = any($2::uuid[])`, command.WorkspaceID, command.Input.EvidenceIDs).Scan(&evidenceCount); err != nil {
		return AgentLifecycleResult{}, err
	}
	if evidenceCount != len(command.Input.EvidenceIDs) {
		return AgentLifecycleResult{}, assuranceNotFound("Evidence")
	}
	resultHash, err := verificationResultHash(command.Input.ClaimID, command.Input.Verdict, command.Input.VerifierVersion, command.Input.EvidenceIDs, command.Input.WaiverReference)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	var existingResultID string
	err = tx.QueryRow(ctx, `select id from verrail_verification_results where claim_id=$1 and result_hash=$2`, command.Input.ClaimID, resultHash).Scan(&existingResultID)
	if err == nil {
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: assuranceResourceVerificationResult, ResourceID: existingResultID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, assuranceVerificationRecordedEvent); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, err
	}
	resultID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_verification_results(id,workspace_id,target_id,claim_id,verdict,verifier_version,evidence_ids,waiver_reference,result_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,'user',$10)`, resultID, command.WorkspaceID, claimTargetID, command.Input.ClaimID, command.Input.Verdict, command.Input.VerifierVersion, command.Input.EvidenceIDs, command.Input.WaiverReference, resultHash, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert VerificationResult: %w", err)
	}
	if nextStatus, ok := claimStatusForVerdict(command.Input.Verdict); ok {
		if _, err := tx.Exec(ctx, `update verrail_claims set status=$1,updated_at=now() where id=$2`, nextStatus, command.Input.ClaimID); err != nil {
			return AgentLifecycleResult{}, fmt.Errorf("update Claim status: %w", err)
		}
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: assuranceResourceVerificationResult, ResourceID: resultID}
	if err := finishAgentCommand(ctx, tx, meta, result, assuranceVerificationRecordedEvent); err != nil {
		return result, err
	}
	return result, nil
}
