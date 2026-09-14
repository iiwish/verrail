package target

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Archival is independent of execution. Definition changes and cancellation of
// execution-bearing Targets require an explicit Graph Engine lifecycle command.
type ManageTargetInput struct {
	ExpectedTargetRevisionID string  `json:"expectedTargetRevisionId"`
	Operation                string  `json:"operation"`
	ExpectedArchiveVersion   *int    `json:"expectedArchiveVersion,omitempty"`
	Title                    *string `json:"title,omitempty"`
	Summary                  *string `json:"summary,omitempty"`
	Goal                     *string `json:"goal,omitempty"`
}
type ManageTargetCommand struct {
	WorkspaceID, TargetID       string
	Principal                   Principal
	IdempotencyKey, RequestHash string
	Input                       ManageTargetInput
}
type ManageTargetResult struct {
	TargetID         string     `json:"targetId"`
	TargetRevisionID string     `json:"targetRevisionId"`
	Operation        string     `json:"operation"`
	Replayed         bool       `json:"replayed"`
	ArchiveVersion   *int       `json:"archiveVersion,omitempty"`
	ArchivedAt       *time.Time `json:"archivedAt,omitempty"`
}

func ValidateManageTargetCommand(command *ManageTargetCommand) error {
	if err := validateCommandIdentity(command.WorkspaceID, command.TargetID, command.Principal, command.IdempotencyKey); err != nil {
		return err
	}
	input := &command.Input
	if !uuidPattern.MatchString(input.ExpectedTargetRevisionID) {
		return validation("expectedTargetRevisionId is required")
	}
	archival := input.Operation == "archive" || input.Operation == "restore"
	if input.Operation != "update" && input.Operation != "cancel" && !archival {
		return validation("operation must be update, cancel, archive or restore")
	}
	if input.Operation != "update" && (input.Title != nil || input.Summary != nil || input.Goal != nil) {
		return validation("only update can change the definition")
	}
	if archival != (input.ExpectedArchiveVersion != nil) || (input.ExpectedArchiveVersion != nil && *input.ExpectedArchiveVersion < 0) {
		return validation("only archive/restore require a nonnegative expectedArchiveVersion")
	}
	if input.Operation == "update" && input.Title == nil && input.Summary == nil && input.Goal == nil {
		return validation("update requires a definition change")
	}
	for _, field := range []struct {
		value *string
		max   int
	}{{input.Title, 160}, {input.Summary, 2000}, {input.Goal, 4000}} {
		if field.value != nil && (strings.TrimSpace(*field.value) == "" || utf8.RuneCountInString(*field.value) > field.max) {
			return validation("definition fields must be nonempty and bounded")
		}
	}
	command.RequestHash = proofHash(map[string]any{"targetId": command.TargetID, "input": input})
	return nil
}

func (store *Store) ManageTarget(ctx context.Context, command ManageTargetCommand) (ManageTargetResult, error) {
	result := ManageTargetResult{}
	if err := ValidateManageTargetCommand(&command); err != nil {
		return result, err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: command.WorkspaceID, Principal: command.Principal}); err != nil {
		return result, err
	}
	const commandType = "target.manage.v1"
	if _, err = tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,0))`, command.WorkspaceID+"\n"+command.Principal.ID+"\n"+commandType+"\n"+command.IdempotencyKey); err != nil {
		return result, err
	}
	var hash string
	var response []byte
	err = tx.QueryRow(ctx, `select request_hash,response from verrail_command_receipts where workspace_id=$1 and principal_type='user' and principal_id=$2 and command_type=$3 and idempotency_key=$4`, command.WorkspaceID, command.Principal.ID, commandType, command.IdempotencyKey).Scan(&hash, &response)
	if err == nil {
		if hash != command.RequestHash {
			return result, IdempotencyConflict()
		}
		if err = json.Unmarshal(response, &result); err != nil {
			return result, err
		}
		result.Replayed = true
		return result, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	var revisionID, graphID, status string
	var graphRevisionID *string
	var archivedAt *time.Time
	var archiveVersion int
	err = tx.QueryRow(ctx, `select t.active_target_revision_id,t.status,g.id,g.active_graph_revision_id,t.archived_at,t.archive_version from verrail_targets t join verrail_work_graphs g on g.target_id=t.id and g.workspace_id=t.workspace_id where t.id=$1 and t.workspace_id=$2 for update`, command.TargetID, command.WorkspaceID).Scan(&revisionID, &status, &graphID, &graphRevisionID, &archivedAt, &archiveVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, NotFound()
	}
	if err != nil {
		return result, err
	}
	if revisionID != command.Input.ExpectedTargetRevisionID {
		return result, &Error{Status: 409, Code: "TARGET_REVISION_CONFLICT", Message: "Target active revision changed"}
	}
	archival := command.Input.Operation == "archive" || command.Input.Operation == "restore"
	if !archival {
		var hasExecution bool
		if err = tx.QueryRow(ctx, `select exists(select 1 from verrail_runs where target_id=$1 and workspace_id=$2) or exists(select 1 from verrail_action_requests where target_id=$1 and workspace_id=$2)`, command.TargetID, command.WorkspaceID).Scan(&hasExecution); err != nil {
			return result, err
		}
		if status == "canceled" || status == "accepted" || graphRevisionID != nil || hasExecution {
			return result, &Error{Status: 409, Code: "TARGET_MANAGEMENT_REQUIRES_DRAFT", Message: "Only unexecuted Targets without an active graph can be changed here"}
		}
	}
	previousRevisionID := revisionID
	if archival {
		if archiveVersion != *command.Input.ExpectedArchiveVersion {
			return result, &Error{Status: 409, Code: "TARGET_ARCHIVE_CONFLICT", Message: "Target archive state changed; query it again"}
		}
		shouldArchive := command.Input.Operation == "archive"
		if shouldArchive == (archivedAt != nil) {
			return result, &Error{Status: 409, Code: "TARGET_ARCHIVE_STATE_UNCHANGED", Message: "Target is already in the requested archive state"}
		}
		// Archival never mutates graph, run, acceptance, or evidence state.
		if err = tx.QueryRow(ctx, `update verrail_targets set archived_at=case when $1 then now() else null end,archive_version=archive_version+1,updated_at=now() where id=$2 and workspace_id=$3 returning archived_at,archive_version`, shouldArchive, command.TargetID, command.WorkspaceID).Scan(&archivedAt, &archiveVersion); err != nil {
			return result, err
		}
	} else if command.Input.Operation == "update" {
		var originalJSON []byte
		if err = tx.QueryRow(ctx, `select to_jsonb(r)-'id'-'created_at'-'created_by_principal_type'-'created_by_principal_id'-'content_hash' from verrail_target_revisions r where id=$1 and workspace_id=$2`, revisionID, command.WorkspaceID).Scan(&originalJSON); err != nil {
			return result, err
		}
		var original map[string]any
		if err = json.Unmarshal(originalJSON, &original); err != nil {
			return result, err
		}
		for key, value := range map[string]*string{"title": command.Input.Title, "summary": command.Input.Summary, "goal": command.Input.Goal} {
			if value != nil {
				original[key] = *value
			}
		}
		original["revision_number"] = original["revision_number"].(float64) + 1
		revisionID, err = NewUUID()
		if err != nil {
			return result, err
		}
		_, err = tx.Exec(ctx, `insert into verrail_target_revisions(id,workspace_id,target_id,revision_number,title,summary,outcome_owner_principal_type,outcome_owner_principal_id,outcome_owner_display_name,goal,constraints,acceptance_criteria,risk_level,deadline,policy_summary,resource_refs,content_hash,created_by_principal_type,created_by_principal_id)
select $1,workspace_id,target_id,revision_number+1,coalesce($2,title),coalesce($3,summary),outcome_owner_principal_type,outcome_owner_principal_id,outcome_owner_display_name,coalesce($4,goal),constraints,acceptance_criteria,risk_level,deadline,policy_summary,resource_refs,$5,'user',$6 from verrail_target_revisions where id=$7 and workspace_id=$8`, revisionID, command.Input.Title, command.Input.Summary, command.Input.Goal, proofHash(original), command.Principal.ID, previousRevisionID, command.WorkspaceID)
		if err != nil {
			return result, err
		}
		_, err = tx.Exec(ctx, `update verrail_targets set active_target_revision_id=$1,updated_at=now() where id=$2 and workspace_id=$3`, revisionID, command.TargetID, command.WorkspaceID)
	} else {
		_, err = tx.Exec(ctx, `update verrail_targets set status='canceled',updated_at=now() where id=$1 and workspace_id=$2`, command.TargetID, command.WorkspaceID)
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_work_graphs set status='canceled',updated_at=now() where id=$1`, graphID)
		}
	}
	if err != nil {
		return result, err
	}
	result = ManageTargetResult{TargetID: command.TargetID, TargetRevisionID: revisionID, Operation: command.Input.Operation}
	if archival {
		result.ArchiveVersion = &archiveVersion
		result.ArchivedAt = archivedAt
	}
	response, _ = json.Marshal(result)
	receiptID, _ := NewUUID()
	if _, err = tx.Exec(ctx, `insert into verrail_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,target_id,target_revision_id,response) values($1,$2,'user',$3,$4,$5,$6,$7,$8,$9::jsonb)`, receiptID, command.WorkspaceID, command.Principal.ID, commandType, command.IdempotencyKey, command.RequestHash, command.TargetID, revisionID, response); err != nil {
		return result, err
	}
	auditID, _ := NewUUID()
	payload, _ := json.Marshal(map[string]any{"operation": command.Input.Operation, "targetRevisionId": revisionID, "previousTargetRevisionId": previousRevisionID, "archiveVersion": archiveVersion, "archivedAt": archivedAt})
	if _, err = tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'user',$3,'target.managed','target',$4,$5,$6::jsonb)`, auditID, command.WorkspaceID, command.Principal.ID, command.TargetID, command.IdempotencyKey, payload); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
