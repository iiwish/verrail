package target

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type agentCommandMeta struct {
	WorkspaceID, CommandType, IdempotencyKey, RequestHash string
	Principal                                             Principal
}

func lifecycleMeta[T any](command AgentLifecycleCommand[T]) agentCommandMeta {
	return agentCommandMeta{command.WorkspaceID, command.CommandType, command.IdempotencyKey, command.RequestHash, command.Principal}
}

func (store *Store) beginAgentCommand(ctx context.Context, meta agentCommandMeta) (pgx.Tx, *AgentLifecycleResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, nil, err
	}
	lockKey := meta.WorkspaceID + "\n" + meta.Principal.ID + "\n" + meta.CommandType + "\n" + meta.IdempotencyKey
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	var existingHash string
	var response []byte
	err = tx.QueryRow(ctx, `select request_hash,response from verrail_agent_command_receipts where workspace_id=$1 and principal_type='user' and principal_id=$2 and command_type=$3 and idempotency_key=$4`, meta.WorkspaceID, meta.Principal.ID, meta.CommandType, meta.IdempotencyKey).Scan(&existingHash, &response)
	if err == nil {
		if existingHash != meta.RequestHash {
			_ = tx.Rollback(ctx)
			return nil, nil, IdempotencyConflict()
		}
		var result AgentLifecycleResult
		if err := json.Unmarshal(response, &result); err != nil {
			_ = tx.Rollback(ctx)
			return nil, nil, err
		}
		result.Replayed = true
		if err := tx.Commit(ctx); err != nil {
			return nil, nil, err
		}
		return nil, &result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	if err := assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: meta.WorkspaceID, Principal: meta.Principal}); err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	return tx, nil, nil
}

func finishAgentCommand(ctx context.Context, tx pgx.Tx, meta agentCommandMeta, result AgentLifecycleResult, eventType string) error {
	receiptID, _ := NewUUID()
	auditID, _ := NewUUID()
	response, _ := json.Marshal(result)
	payload, _ := json.Marshal(map[string]any{"schemaVersion": SchemaVersion, "resourceType": result.ResourceType, "resourceId": result.ResourceID})
	if _, err := tx.Exec(ctx, `insert into verrail_agent_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,response) values($1,$2,'user',$3,$4,$5,$6,$7::jsonb)`, receiptID, meta.WorkspaceID, meta.Principal.ID, meta.CommandType, meta.IdempotencyKey, meta.RequestHash, response); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'user',$3,$4,$5,$6,$7,$8::jsonb)`, auditID, meta.WorkspaceID, meta.Principal.ID, eventType, result.ResourceType, result.ResourceID, meta.IdempotencyKey, payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (store *Store) CreateAgentDefinition(ctx context.Context, command AgentLifecycleCommand[AgentDefinitionInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if command.Input.CompatibilityAgentID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from agents where id=$1 and company_id=$2)`, *command.Input.CompatibilityAgentID, command.WorkspaceID).Scan(&exists); err != nil || !exists {
			if err != nil {
				return AgentLifecycleResult{}, err
			}
			return AgentLifecycleResult{}, NotFound()
		}
	}
	id, _ := NewUUID()
	_, err = tx.Exec(ctx, `insert into verrail_agent_definitions(id,workspace_id,compatibility_agent_id,name,description,status,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,'draft','user',$6)`, id, command.WorkspaceID, command.Input.CompatibilityAgentID, command.Input.Name, command.Input.Description, command.Principal.ID)
	if err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert AgentDefinition: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "agent_definition", ResourceID: id}
	if err := finishAgentCommand(ctx, tx, meta, result, "agent_definition.created"); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) UpdateAgentDefinition(ctx context.Context, command AgentLifecycleCommand[UpdateAgentDefinitionInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var name string
	var description *string
	var status string
	if err := tx.QueryRow(ctx, `select name,description,status from verrail_agent_definitions where id=$1 and workspace_id=$2 for update`, command.ResourceID, command.WorkspaceID).Scan(&name, &description, &status); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, NotFound()
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if status == "retired" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "AGENT_DEFINITION_RETIRED", Message: "Retired AgentDefinition cannot be edited"}
	}
	if command.Input.Name != nil {
		name = *command.Input.Name
	}
	if command.Input.DescriptionPresent {
		description = command.Input.Description
	}
	if _, err := tx.Exec(ctx, `update verrail_agent_definitions set name=$1,description=$2,updated_at=now() where id=$3`, name, description, command.ResourceID); err != nil {
		return AgentLifecycleResult{}, err
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "agent_definition", ResourceID: command.ResourceID}
	if err := finishAgentCommand(ctx, tx, meta, result, "agent_definition.updated"); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) PublishAgentVersion(ctx context.Context, command AgentLifecycleCommand[PublishAgentVersionInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	if err := tx.QueryRow(ctx, `select status from verrail_agent_definitions where id=$1 and workspace_id=$2 for update`, command.ResourceID, command.WorkspaceID).Scan(&status); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, NotFound()
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if status == "retired" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "AGENT_DEFINITION_RETIRED", Message: "Retired AgentDefinition cannot be published"}
	}
	var existingID string
	err = tx.QueryRow(ctx, `select id from verrail_agent_versions where agent_definition_id=$1 and content_hash=$2`, command.ResourceID, command.RequestHash).Scan(&existingID)
	if err == nil {
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "agent_version", ResourceID: existingID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, "agent_version.reused"); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, err
	}
	var versionNumber int
	if err := tx.QueryRow(ctx, `select coalesce(max(version_number),0)+1 from verrail_agent_versions where agent_definition_id=$1`, command.ResourceID).Scan(&versionNumber); err != nil {
		return AgentLifecycleResult{}, err
	}
	id, _ := NewUUID()
	skills, _ := json.Marshal(command.Input.Skills)
	tools, _ := json.Marshal(command.Input.Tools)
	output, _ := json.Marshal(command.Input.OutputSchema)
	ceiling, _ := json.Marshal(command.Input.CapabilityCeiling)
	supply, _ := json.Marshal(command.Input.SupplyChain)
	_, err = tx.Exec(ctx, `insert into verrail_agent_versions(id,workspace_id,agent_definition_id,version_number,runtime,model,prompt,skills,tools,output_schema,capability_ceiling,supply_chain,content_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,'user',$14)`, id, command.WorkspaceID, command.ResourceID, versionNumber, command.Input.Runtime, command.Input.Model, command.Input.Prompt, skills, tools, output, ceiling, supply, command.RequestHash, command.Principal.ID)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_agent_definitions set status='published',updated_at=now() where id=$1`, command.ResourceID); err != nil {
		return AgentLifecycleResult{}, err
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "agent_version", ResourceID: id}
	if err := finishAgentCommand(ctx, tx, meta, result, "agent_version.published"); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) RecordEvaluationRun(ctx context.Context, command AgentLifecycleCommand[EvaluationRunInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var definitionID string
	if err := tx.QueryRow(ctx, `select agent_definition_id from verrail_agent_versions where id=$1 and workspace_id=$2`, command.Input.CandidateAgentVersionID, command.WorkspaceID).Scan(&definitionID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, NotFound()
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if command.Input.BaselineAgentVersionID != nil {
		var baselineDefinitionID string
		if err := tx.QueryRow(ctx, `select agent_definition_id from verrail_agent_versions where id=$1 and workspace_id=$2`, *command.Input.BaselineAgentVersionID, command.WorkspaceID).Scan(&baselineDefinitionID); errors.Is(err, pgx.ErrNoRows) {
			return AgentLifecycleResult{}, NotFound()
		} else if err != nil {
			return AgentLifecycleResult{}, err
		}
		if baselineDefinitionID != definitionID {
			return AgentLifecycleResult{}, validation("Evaluation baseline must belong to the same AgentDefinition")
		}
	}
	id, _ := NewUUID()
	_, err = tx.Exec(ctx, `insert into verrail_evaluation_runs(id,workspace_id,candidate_agent_version_id,baseline_agent_version_id,status,quality_score,cost_cents,latency_ms,safety_status,summary,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user',$11)`, id, command.WorkspaceID, command.Input.CandidateAgentVersionID, command.Input.BaselineAgentVersionID, command.Input.Status, command.Input.QualityScore, command.Input.CostCents, command.Input.LatencyMS, command.Input.SafetyStatus, command.Input.Summary, command.Principal.ID)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "evaluation_run", ResourceID: id}
	if err := finishAgentCommand(ctx, tx, meta, result, "evaluation_run.recorded"); err != nil {
		return result, err
	}
	return result, nil
}

func assertPassingEvaluation(ctx context.Context, tx pgx.Tx, workspaceID, versionID, evaluationID string) error {
	var status, safety string
	var candidate string
	if err := tx.QueryRow(ctx, `select candidate_agent_version_id,status,safety_status from verrail_evaluation_runs where id=$1 and workspace_id=$2`, evaluationID, workspaceID).Scan(&candidate, &status, &safety); errors.Is(err, pgx.ErrNoRows) {
		return NotFound()
	} else if err != nil {
		return err
	}
	if candidate != versionID || status != "passed" || safety != "passed" {
		return &Error{Status: 409, Code: "AGENT_EVALUATION_GATE_FAILED", Message: "A passing evaluation for the selected AgentVersion is required"}
	}
	return nil
}

func (store *Store) CreateDeployment(ctx context.Context, command AgentLifecycleCommand[CreateDeploymentInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var definitionID string
	if err := tx.QueryRow(ctx, `select agent_definition_id from verrail_agent_versions where id=$1 and workspace_id=$2`, command.Input.AgentVersionID, command.WorkspaceID).Scan(&definitionID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, NotFound()
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if definitionID != command.Input.AgentDefinitionID {
		return AgentLifecycleResult{}, validation("AgentVersion does not belong to AgentDefinition")
	}
	if err := assertPassingEvaluation(ctx, tx, command.WorkspaceID, command.Input.AgentVersionID, command.Input.EvaluationRunID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, command.WorkspaceID+"\ndefault-deployment"); err != nil {
		return AgentLifecycleResult{}, err
	}
	var hasDefault bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from verrail_deployments where workspace_id=$1 and is_default)`, command.WorkspaceID).Scan(&hasDefault); err != nil {
		return AgentLifecycleResult{}, err
	}
	isDefault := command.Input.IsDefault || !hasDefault
	if isDefault {
		if _, err := tx.Exec(ctx, `update verrail_deployments set is_default=false,updated_at=now() where workspace_id=$1 and is_default`, command.WorkspaceID); err != nil {
			return AgentLifecycleResult{}, err
		}
	}
	deploymentID, _ := NewUUID()
	revisionID, _ := NewUUID()
	config, _ := json.Marshal(command.Input.RuntimeConfig)
	digest := command.RequestHash
	if _, err := tx.Exec(ctx, `insert into verrail_deployments(id,workspace_id,agent_definition_id,name,status,is_default,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,'active',$5,'user',$6)`, deploymentID, command.WorkspaceID, command.Input.AgentDefinitionID, command.Input.Name, isDefault, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_deployment_revisions(id,workspace_id,deployment_id,revision_number,agent_version_id,evaluation_run_id,state,runtime_config,content_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,1,$4,$5,'active',$6::jsonb,$7,'user',$8)`, revisionID, command.WorkspaceID, deploymentID, command.Input.AgentVersionID, command.Input.EvaluationRunID, config, digest, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, err
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "deployment", ResourceID: deploymentID}
	if err := finishAgentCommand(ctx, tx, meta, result, "deployment.created"); err != nil {
		return result, err
	}
	return result, nil
}

// deploymentRevisionGate rejects lifecycle actions that would mutate a
// Deployment out of a terminal state. Retirement is terminal for a production
// execution identity: without this guard a retired Deployment could be
// resurrected via pause→resume, upgrade, or rollback, each of which
// unconditionally sets status back to "active". This includes a repeated
// retire: rejected (rather than treated as idempotent) so an accidental
// repeat surfaces as a conflict instead of silently rewriting revision
// history, while the first retire on a live Deployment is unaffected.
func deploymentRevisionGate(action, status string) error {
	if status != "retired" {
		return nil
	}
	return &Error{Status: 409, Code: "DEPLOYMENT_RETIRED", Message: "Retired Deployment cannot accept action " + action}
}

func (store *Store) ReviseDeployment(ctx context.Context, command AgentLifecycleCommand[ReviseDeploymentInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var definitionID, status string
	if err := tx.QueryRow(ctx, `select agent_definition_id,status from verrail_deployments where id=$1 and workspace_id=$2 for update`, command.ResourceID, command.WorkspaceID).Scan(&definitionID, &status); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, NotFound()
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if err := deploymentRevisionGate(command.Input.Action, status); err != nil {
		return AgentLifecycleResult{}, err
	}
	if command.Input.Action == "set_default" {
		if status != "active" {
			return AgentLifecycleResult{}, &Error{Status: 409, Code: "DEPLOYMENT_NOT_ACTIVE", Message: "Only an active Deployment can be the default"}
		}
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, command.WorkspaceID+"\ndefault-deployment"); err != nil {
			return AgentLifecycleResult{}, err
		}
		if _, err := tx.Exec(ctx, `update verrail_deployments set is_default=false,updated_at=now() where workspace_id=$1 and is_default`, command.WorkspaceID); err != nil {
			return AgentLifecycleResult{}, err
		}
		if _, err := tx.Exec(ctx, `update verrail_deployments set is_default=true,updated_at=now() where id=$1`, command.ResourceID); err != nil {
			return AgentLifecycleResult{}, err
		}
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "deployment", ResourceID: command.ResourceID}
		if err := finishAgentCommand(ctx, tx, meta, result, "deployment.default_changed"); err != nil {
			return result, err
		}
		return result, nil
	}
	var versionID, evaluationID, currentState string
	var configBytes []byte
	var nextNumber int
	if err := tx.QueryRow(ctx, `select agent_version_id,evaluation_run_id,state,runtime_config,revision_number+1 from verrail_deployment_revisions where deployment_id=$1 order by revision_number desc limit 1`, command.ResourceID).Scan(&versionID, &evaluationID, &currentState, &configBytes, &nextNumber); err != nil {
		return AgentLifecycleResult{}, err
	}
	newState := "active"
	eventType := "deployment." + command.Input.Action
	switch command.Input.Action {
	case "pause":
		newState = "paused"
		status = "paused"
	case "resume":
		if status != "paused" {
			return AgentLifecycleResult{}, &Error{Status: 409, Code: "DEPLOYMENT_NOT_PAUSED", Message: "Deployment is not paused"}
		}
		status = "active"
	case "retire":
		newState = "retired"
		status = "retired"
	case "upgrade":
		versionID = *command.Input.AgentVersionID
		evaluationID = *command.Input.EvaluationRunID
		var candidateDefinition string
		if err := tx.QueryRow(ctx, `select agent_definition_id from verrail_agent_versions where id=$1 and workspace_id=$2`, versionID, command.WorkspaceID).Scan(&candidateDefinition); err != nil {
			return AgentLifecycleResult{}, NotFound()
		}
		if candidateDefinition != definitionID {
			return AgentLifecycleResult{}, validation("AgentVersion does not belong to Deployment definition")
		}
		if err := assertPassingEvaluation(ctx, tx, command.WorkspaceID, versionID, evaluationID); err != nil {
			return AgentLifecycleResult{}, err
		}
		if command.Input.RuntimeConfig != nil {
			configBytes, _ = json.Marshal(command.Input.RuntimeConfig)
		}
		status = "active"
	case "rollback":
		if err := tx.QueryRow(ctx, `select agent_version_id,evaluation_run_id,runtime_config from verrail_deployment_revisions where id=$1 and deployment_id=$2 and workspace_id=$3`, *command.Input.SourceDeploymentRevisionID, command.ResourceID, command.WorkspaceID).Scan(&versionID, &evaluationID, &configBytes); errors.Is(err, pgx.ErrNoRows) {
			return AgentLifecycleResult{}, NotFound()
		} else if err != nil {
			return AgentLifecycleResult{}, err
		}
		if err := assertPassingEvaluation(ctx, tx, command.WorkspaceID, versionID, evaluationID); err != nil {
			return AgentLifecycleResult{}, err
		}
		status = "active"
	}
	if command.Input.RuntimeConfig != nil && command.Input.Action != "upgrade" {
		configBytes, _ = json.Marshal(command.Input.RuntimeConfig)
	}
	revisionID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_deployment_revisions(id,workspace_id,deployment_id,revision_number,agent_version_id,evaluation_run_id,state,runtime_config,content_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'user',$10)`, revisionID, command.WorkspaceID, command.ResourceID, nextNumber, versionID, evaluationID, newState, configBytes, command.RequestHash, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_deployments set status=$1,updated_at=now() where id=$2`, status, command.ResourceID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if status == "retired" {
		var wasDefault bool
		if err := tx.QueryRow(ctx, `select is_default from verrail_deployments where id=$1`, command.ResourceID).Scan(&wasDefault); err != nil {
			return AgentLifecycleResult{}, err
		}
		if wasDefault {
			if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, command.WorkspaceID+"\ndefault-deployment"); err != nil {
				return AgentLifecycleResult{}, err
			}
			var replacementID string
			err := tx.QueryRow(ctx, `select id from verrail_deployments where workspace_id=$1 and id<>$2 and status='active' order by created_at,id limit 1 for update`, command.WorkspaceID, command.ResourceID).Scan(&replacementID)
			if errors.Is(err, pgx.ErrNoRows) {
				return AgentLifecycleResult{}, &Error{Status: 409, Code: "DEFAULT_DEPLOYMENT_REQUIRED", Message: "Set another active default Deployment before retiring this one"}
			}
			if err != nil {
				return AgentLifecycleResult{}, err
			}
			if _, err := tx.Exec(ctx, `update verrail_deployments set is_default=false,updated_at=now() where workspace_id=$1 and is_default`, command.WorkspaceID); err != nil {
				return AgentLifecycleResult{}, err
			}
			if _, err := tx.Exec(ctx, `update verrail_deployments set is_default=true,updated_at=now() where id=$1`, replacementID); err != nil {
				return AgentLifecycleResult{}, err
			}
		}
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "deployment_revision", ResourceID: revisionID}
	if err := finishAgentCommand(ctx, tx, meta, result, eventType); err != nil {
		return result, err
	}
	return result, nil
}
