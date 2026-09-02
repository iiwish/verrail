package target

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	createGraphRevisionCommandType   = "graph.revision.create.v1"
	activateGraphRevisionCommandType = "graph.revision.activate.v1"
)

func (store *Store) CreateGraphRevision(ctx context.Context, command CreateGraphRevisionCommand) (CreateGraphRevisionResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return CreateGraphRevisionResult{}, fmt.Errorf("begin GraphRevision transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockKey := command.WorkspaceID + "\n" + command.Principal.ID + "\n" + createGraphRevisionCommandType + "\n" + command.IdempotencyKey
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return CreateGraphRevisionResult{}, err
	}
	var existingHash string
	var existingResponse []byte
	err = tx.QueryRow(ctx, `select request_hash, response from verrail_command_receipts where workspace_id=$1 and principal_type='user' and principal_id=$2 and command_type=$3 and idempotency_key=$4`, command.WorkspaceID, command.Principal.ID, createGraphRevisionCommandType, command.IdempotencyKey).Scan(&existingHash, &existingResponse)
	if err == nil {
		if existingHash != command.RequestHash {
			return CreateGraphRevisionResult{}, IdempotencyConflict()
		}
		var result CreateGraphRevisionResult
		if err := json.Unmarshal(existingResponse, &result); err != nil {
			return result, err
		}
		result.Replayed = true
		if err := tx.Commit(ctx); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CreateGraphRevisionResult{}, err
	}
	if err := assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: command.WorkspaceID, Principal: command.Principal}); err != nil {
		return CreateGraphRevisionResult{}, err
	}
	var activeTargetRevisionID, workGraphID string
	err = tx.QueryRow(ctx, `select target.active_target_revision_id, graph.id from verrail_targets target join verrail_work_graphs graph on graph.target_id=target.id and graph.workspace_id=target.workspace_id where target.workspace_id=$1 and target.id=$2 for update`, command.WorkspaceID, command.TargetID).Scan(&activeTargetRevisionID, &workGraphID)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateGraphRevisionResult{}, NotFound()
	}
	if err != nil {
		return CreateGraphRevisionResult{}, err
	}
	if activeTargetRevisionID != command.Input.ExpectedTargetRevisionID {
		return CreateGraphRevisionResult{}, &Error{Status: 409, Code: "TARGET_REVISION_CONFLICT", Message: "Target active revision changed"}
	}
	var revisionNumber int
	if err := tx.QueryRow(ctx, `select coalesce(max(revision_number),0)+1 from verrail_graph_revisions where work_graph_id=$1`, workGraphID).Scan(&revisionNumber); err != nil {
		return CreateGraphRevisionResult{}, err
	}
	graphRevisionID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_graph_revisions (id,workspace_id,target_id,target_revision_id,work_graph_id,revision_number,status,content_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,'draft',$7,'user',$8)`, graphRevisionID, command.WorkspaceID, command.TargetID, activeTargetRevisionID, workGraphID, revisionNumber, command.RequestHash, command.Principal.ID); err != nil {
		return CreateGraphRevisionResult{}, err
	}
	for _, node := range command.Input.Nodes {
		nodeID, _ := NewUUID()
		dependencies, _ := json.Marshal(node.DependencyNodeKeys)
		var principalType, principalID *string
		if node.ResponsiblePrincipal != nil {
			principalType = &node.ResponsiblePrincipal.PrincipalType
			principalID = &node.ResponsiblePrincipal.PrincipalID
		}
		if node.Kind == "agent_task" {
			var validDeploymentRevision bool
			err := tx.QueryRow(ctx, `select exists(select 1 from verrail_deployment_revisions revision join verrail_deployments deployment on deployment.id=revision.deployment_id and deployment.workspace_id=revision.workspace_id where revision.id=$1 and revision.workspace_id=$2 and revision.state='active' and deployment.status='active' and not exists(select 1 from verrail_deployment_revisions newer where newer.deployment_id=revision.deployment_id and newer.revision_number>revision.revision_number))`, node.ResponsiblePrincipal.PrincipalID, command.WorkspaceID).Scan(&validDeploymentRevision)
			if err != nil {
				return CreateGraphRevisionResult{}, err
			}
			if !validDeploymentRevision {
				return CreateGraphRevisionResult{}, &Error{Status: 409, Code: "DEPLOYMENT_REVISION_NOT_ACTIVE", Message: "AgentTask requires the active DeploymentRevision"}
			}
		}
		if _, err := tx.Exec(ctx, `insert into verrail_work_nodes (id,workspace_id,target_id,graph_revision_id,node_key,kind,title,stage_key,status,responsible_principal_type,responsible_principal_id,dependency_node_keys,completion_definition) values($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11::jsonb,$12)`, nodeID, command.WorkspaceID, command.TargetID, graphRevisionID, node.NodeKey, node.Kind, node.Title, node.Stage, principalType, principalID, dependencies, node.CompletionDefinition); err != nil {
			return CreateGraphRevisionResult{}, err
		}
	}
	result := CreateGraphRevisionResult{SchemaVersion: SchemaVersion, TargetID: command.TargetID, TargetRevisionID: activeTargetRevisionID, WorkGraphID: workGraphID, GraphRevisionID: graphRevisionID, RevisionNumber: revisionNumber}
	responseJSON, _ := json.Marshal(result)
	receiptID, _ := NewUUID()
	auditID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,target_id,target_revision_id,response) values($1,$2,'user',$3,$4,$5,$6,$7,$8,$9::jsonb)`, receiptID, command.WorkspaceID, command.Principal.ID, createGraphRevisionCommandType, command.IdempotencyKey, command.RequestHash, command.TargetID, activeTargetRevisionID, responseJSON); err != nil {
		return result, err
	}
	payload, _ := json.Marshal(map[string]any{"graphRevisionId": graphRevisionID, "revisionNumber": revisionNumber})
	if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'user',$3,'graph.revision_created','target',$4,$5,$6::jsonb)`, auditID, command.WorkspaceID, command.Principal.ID, command.TargetID, command.IdempotencyKey, payload); err != nil {
		return result, err
	}
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) ActivateGraphRevision(ctx context.Context, command ActivateGraphRevisionCommand) (ActivateGraphRevisionResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockKey := command.WorkspaceID + "\n" + command.Principal.ID + "\n" + activateGraphRevisionCommandType + "\n" + command.IdempotencyKey
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	var existingHash string
	var existingResponse []byte
	err = tx.QueryRow(ctx, `select request_hash, response from verrail_command_receipts where workspace_id=$1 and principal_type='user' and principal_id=$2 and command_type=$3 and idempotency_key=$4`, command.WorkspaceID, command.Principal.ID, activateGraphRevisionCommandType, command.IdempotencyKey).Scan(&existingHash, &existingResponse)
	if err == nil {
		if existingHash != command.RequestHash {
			return ActivateGraphRevisionResult{}, IdempotencyConflict()
		}
		var result ActivateGraphRevisionResult
		if err := json.Unmarshal(existingResponse, &result); err != nil {
			return result, err
		}
		result.Replayed = true
		if err := tx.Commit(ctx); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ActivateGraphRevisionResult{}, err
	}
	if err := assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: command.WorkspaceID, Principal: command.Principal}); err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	var workGraphID, targetRevisionID, status string
	var revisionNumber int
	var activatedAt *time.Time
	err = tx.QueryRow(ctx, `select revision.work_graph_id,revision.target_revision_id,revision.revision_number,revision.status,revision.activated_at from verrail_graph_revisions revision join verrail_targets target on target.id=revision.target_id and target.workspace_id=revision.workspace_id and target.active_target_revision_id=revision.target_revision_id where revision.workspace_id=$1 and revision.target_id=$2 and revision.id=$3 for update of revision`, command.WorkspaceID, command.TargetID, command.GraphRevisionID).Scan(&workGraphID, &targetRevisionID, &revisionNumber, &status, &activatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ActivateGraphRevisionResult{}, NotFound()
	}
	if err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	if status == "active" && activatedAt != nil {
		result := ActivateGraphRevisionResult{CreateGraphRevisionResult: CreateGraphRevisionResult{SchemaVersion: SchemaVersion, TargetID: command.TargetID, TargetRevisionID: targetRevisionID, WorkGraphID: workGraphID, GraphRevisionID: command.GraphRevisionID, RevisionNumber: revisionNumber}, ActivatedAt: activatedAt.UTC().Format(time.RFC3339Nano)}
		if err := insertActivationReceipt(ctx, tx, command, result); err != nil {
			return result, err
		}
		if err := tx.Commit(ctx); err != nil {
			return result, err
		}
		result.Replayed = true
		return result, nil
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `update verrail_graph_revisions set status='superseded' where work_graph_id=$1 and status='active'`, workGraphID); err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_graph_revisions set status='active',activated_at=$1 where id=$2`, now, command.GraphRevisionID); err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_work_graphs set status='active',active_graph_revision_id=$1,updated_at=$2 where id=$3`, command.GraphRevisionID, now, workGraphID); err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_work_nodes set status='ready',updated_at=$1 where graph_revision_id=$2 and dependency_node_keys='[]'::jsonb`, now, command.GraphRevisionID); err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	auditID, _ := NewUUID()
	outboxID, _ := NewUUID()
	payload, _ := json.Marshal(map[string]any{"schemaVersion": SchemaVersion, "targetId": command.TargetID, "targetRevisionId": targetRevisionID, "graphRevisionId": command.GraphRevisionID})
	result := ActivateGraphRevisionResult{CreateGraphRevisionResult: CreateGraphRevisionResult{SchemaVersion: SchemaVersion, TargetID: command.TargetID, TargetRevisionID: targetRevisionID, WorkGraphID: workGraphID, GraphRevisionID: command.GraphRevisionID, RevisionNumber: revisionNumber}, ActivatedAt: now.Format(time.RFC3339Nano)}
	if err := insertActivationReceipt(ctx, tx, command, result); err != nil {
		return result, err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'user',$3,'graph.activated','target',$4,$5,$6::jsonb)`, auditID, command.WorkspaceID, command.Principal.ID, command.TargetID, command.IdempotencyKey, payload); err != nil {
		return result, err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_outbox_events(id,workspace_id,aggregate_type,aggregate_id,event_type,payload) values($1,$2,'target',$3,'verrail.graph.activated.v1',$4::jsonb)`, outboxID, command.WorkspaceID, command.TargetID, payload); err != nil {
		return ActivateGraphRevisionResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func insertActivationReceipt(ctx context.Context, tx pgx.Tx, command ActivateGraphRevisionCommand, result ActivateGraphRevisionResult) error {
	responseJSON, err := json.Marshal(result)
	if err != nil {
		return err
	}
	receiptID, _ := NewUUID()
	_, err = tx.Exec(ctx, `insert into verrail_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,target_id,target_revision_id,response) values($1,$2,'user',$3,$4,$5,$6,$7,$8,$9::jsonb)`, receiptID, command.WorkspaceID, command.Principal.ID, activateGraphRevisionCommandType, command.IdempotencyKey, command.RequestHash, command.TargetID, result.TargetRevisionID, responseJSON)
	return err
}

func (store *Store) CreateRun(ctx context.Context, command CreateRunCommand) (CreateRunResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return CreateRunResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: command.WorkspaceID, Principal: command.Principal}); err != nil {
		return CreateRunResult{}, err
	}
	var existing CreateRunResult
	var existingKind, existingActorType, existingActorID string
	err = tx.QueryRow(ctx, `select id,target_id,target_revision_id,graph_revision_id,work_node_id,status,kind,actor_principal_type,actor_principal_id,deployment_revision_id,agent_version_id from verrail_runs where workspace_id=$1 and idempotency_key=$2`, command.WorkspaceID, command.IdempotencyKey).Scan(&existing.RunID, &existing.TargetID, &existing.TargetRevisionID, &existing.GraphRevisionID, &existing.WorkNodeID, &existing.Status, &existingKind, &existingActorType, &existingActorID, &existing.DeploymentRevisionID, &existing.AgentVersionID)
	if err == nil {
		expectedKind := "agent"
		if command.Input.Kind == "integration_run" {
			expectedKind = "integration"
		}
		if existing.TargetID != command.TargetID || existing.GraphRevisionID != command.GraphRevisionID || existing.WorkNodeID != command.WorkNodeID || existingKind != expectedKind || existingActorType != command.Input.Actor.PrincipalType || existingActorID != command.Input.Actor.PrincipalID {
			return CreateRunResult{}, IdempotencyConflict()
		}
		existing.SchemaVersion = SchemaVersion
		existing.Replayed = true
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return existing, err
	}
	var targetRevisionID, nodeKind, nodeStatus string
	var responsibleType, responsibleID *string
	err = tx.QueryRow(ctx, `select revision.target_revision_id,node.kind,node.status,node.responsible_principal_type,node.responsible_principal_id from verrail_work_nodes node join verrail_graph_revisions revision on revision.id=node.graph_revision_id join verrail_work_graphs graph on graph.id=revision.work_graph_id where node.workspace_id=$1 and node.target_id=$2 and node.graph_revision_id=$3 and node.id=$4 and revision.status='active' and graph.active_graph_revision_id=revision.id for update of node`, command.WorkspaceID, command.TargetID, command.GraphRevisionID, command.WorkNodeID).Scan(&targetRevisionID, &nodeKind, &nodeStatus, &responsibleType, &responsibleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateRunResult{}, NotFound()
	}
	if err != nil {
		return CreateRunResult{}, err
	}
	if nodeStatus != "ready" {
		return CreateRunResult{}, &Error{Status: 409, Code: "WORK_NODE_NOT_READY", Message: "WorkNode is not ready"}
	}
	if (command.Input.Kind == "agent_run" && nodeKind != "agent_task") || (command.Input.Kind == "integration_run" && nodeKind != "integration_task") {
		return CreateRunResult{}, validation("Run kind does not match WorkNode")
	}
	runID, _ := NewUUID()
	storedKind := "agent"
	var deploymentRevisionID, agentVersionID *string
	if command.Input.Kind == "integration_run" {
		storedKind = "integration"
	} else {
		if responsibleType == nil || responsibleID == nil || *responsibleType != "agent" || command.Input.Actor.PrincipalType != "agent" || command.Input.Actor.PrincipalID != *responsibleID {
			return CreateRunResult{}, &Error{Status: 409, Code: "RUN_ACTOR_DEPLOYMENT_MISMATCH", Message: "Run actor must match the WorkNode DeploymentRevision"}
		}
		var resolvedVersionID string
		err := tx.QueryRow(ctx, `select revision.agent_version_id from verrail_deployment_revisions revision join verrail_deployments deployment on deployment.id=revision.deployment_id and deployment.workspace_id=revision.workspace_id where revision.id=$1 and revision.workspace_id=$2 and revision.state='active' and deployment.status='active' and not exists(select 1 from verrail_deployment_revisions newer where newer.deployment_id=revision.deployment_id and newer.revision_number>revision.revision_number)`, *responsibleID, command.WorkspaceID).Scan(&resolvedVersionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return CreateRunResult{}, &Error{Status: 409, Code: "DEPLOYMENT_REVISION_NOT_ACTIVE", Message: "Run DeploymentRevision is no longer active"}
		}
		if err != nil {
			return CreateRunResult{}, err
		}
		deploymentRevisionID, agentVersionID = responsibleID, &resolvedVersionID
	}
	if _, err := tx.Exec(ctx, `insert into verrail_runs(id,workspace_id,target_id,target_revision_id,graph_revision_id,work_node_id,kind,status,actor_principal_type,actor_principal_id,deployment_revision_id,agent_version_id,attempt_count,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11,0,$12)`, runID, command.WorkspaceID, command.TargetID, targetRevisionID, command.GraphRevisionID, command.WorkNodeID, storedKind, command.Input.Actor.PrincipalType, command.Input.Actor.PrincipalID, deploymentRevisionID, agentVersionID, command.IdempotencyKey); err != nil {
		return CreateRunResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_work_nodes set status='running',updated_at=now() where id=$1`, command.WorkNodeID); err != nil {
		return CreateRunResult{}, err
	}
	auditID, _ := NewUUID()
	outboxID, _ := NewUUID()
	payload, _ := json.Marshal(map[string]any{"schemaVersion": SchemaVersion, "targetId": command.TargetID, "targetRevisionId": targetRevisionID, "graphRevisionId": command.GraphRevisionID, "workNodeId": command.WorkNodeID, "runId": runID})
	if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'user',$3,'run.created','target',$4,$5,$6::jsonb)`, auditID, command.WorkspaceID, command.Principal.ID, command.TargetID, command.IdempotencyKey, payload); err != nil {
		return CreateRunResult{}, err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_outbox_events(id,workspace_id,aggregate_type,aggregate_id,event_type,payload) values($1,$2,'run',$3,'verrail.run.created.v1',$4::jsonb)`, outboxID, command.WorkspaceID, runID, payload); err != nil {
		return CreateRunResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateRunResult{}, err
	}
	return CreateRunResult{SchemaVersion: SchemaVersion, RunID: runID, TargetID: command.TargetID, TargetRevisionID: targetRevisionID, GraphRevisionID: command.GraphRevisionID, WorkNodeID: command.WorkNodeID, DeploymentRevisionID: deploymentRevisionID, AgentVersionID: agentVersionID, Status: "queued"}, nil
}
