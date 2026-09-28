package target

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// Called only after current Attempt, executor, lease, fence, cursor and success
// transition checks. Output registration commits atomically with the terminal event.
func insertRunArtifacts(ctx context.Context, tx pgx.Tx, command ReportRunEventCommand, targetID, workNodeID string) error {
	for _, artifact := range command.Input.Artifacts {
		artifactID, err := NewUUID()
		if err != nil {
			return err
		}
		revisionID, err := NewUUID()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `insert into verrail_artifacts(id,workspace_id,target_id,kind,title,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,'service',$6)`, artifactID, command.WorkspaceID, targetID, artifact.Kind, artifact.Title, command.Principal.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `insert into verrail_artifact_revisions(id,workspace_id,artifact_id,revision_number,content_hash,content_ref,source_run_id,source_work_node_id,created_by_principal_type,created_by_principal_id) values($1,$2,$3,1,$4,$5,$6,$7,'service',$8)`, revisionID, command.WorkspaceID, artifactID, artifact.ContentHash, artifact.ContentRef, command.RunID, workNodeID, command.Principal.ID); err != nil {
			return err
		}
		for _, event := range []struct{ eventType, resourceType, resourceID string }{
			{assuranceArtifactCreatedEvent, assuranceResourceArtifact, artifactID},
			{assuranceArtifactRevisionAddedEvent, assuranceResourceArtifactRevision, revisionID},
		} {
			auditID, err := NewUUID()
			if err != nil {
				return err
			}
			payload, err := json.Marshal(map[string]any{"schemaVersion": SchemaVersion, "resourceType": event.resourceType, "resourceId": event.resourceID, "runId": command.RunID, "runAttemptId": command.RunAttemptID, "workNodeId": workNodeID, "fencingToken": command.Input.FencingToken, "contentHash": artifact.ContentHash})
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'service',$3,$4,$5,$6,$7,$8::jsonb)`, auditID, command.WorkspaceID, command.Principal.ID, event.eventType, event.resourceType, event.resourceID, command.IdempotencyKey, payload); err != nil {
				return err
			}
		}
	}
	return nil
}
