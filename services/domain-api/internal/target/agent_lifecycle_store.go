package target

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type agentCommandMeta struct {
	WorkspaceID, CommandType, IdempotencyKey, RequestHash string
	Principal                                             Principal
}

// Registered workspaces are resolved once; historical revisions retain their pinned path.
func resolveDeploymentWorkspace(ctx context.Context, tx pgx.Tx, workspaceID string, config map[string]any) (map[string]any, error) {
	value, ok := config["projectWorkspaceId"]
	if !ok {
		return config, nil
	}
	id, ok := value.(string)
	if !ok || !uuidPattern.MatchString(id) {
		return nil, validation("projectWorkspaceId must be a UUID")
	}
	var cwd, sourceType *string
	if err := tx.QueryRow(ctx, `select cwd,source_type from project_workspaces where id=$1 and company_id=$2`, id, workspaceID).Scan(&cwd, &sourceType); errors.Is(err, pgx.ErrNoRows) {
		return nil, NotFound()
	} else if err != nil {
		return nil, err
	}
	if cwd == nil || !filepath.IsAbs(*cwd) || strings.ContainsRune(*cwd, 0) || (sourceType != nil && *sourceType != "local_path") {
		return nil, validation("Deployment requires a registered local workspace with an absolute path")
	}
	resolved := make(map[string]any, len(config)+1)
	for key, item := range config {
		resolved[key] = item
	}
	resolved["cwd"] = *cwd
	return resolved, nil
}

func activationRuntimeConfig(ctx context.Context, tx pgx.Tx, workspaceID, versionID string, fallback map[string]any) (map[string]any, error) {
	var mode string
	var savedCwd *string
	if err := tx.QueryRow(ctx, `select coalesce(v.supply_chain->>'mode',''),a.adapter_config->>'cwd' from verrail_agent_versions v join verrail_agent_definitions d on d.id=v.agent_definition_id and d.workspace_id=v.workspace_id left join agents a on a.id=d.compatibility_agent_id and a.company_id=d.workspace_id where v.id=$1 and v.workspace_id=$2`, versionID, workspaceID).Scan(&mode, &savedCwd); err != nil {
		return nil, err
	}
	if mode == "director_chat" {
		return map[string]any{}, nil
	}
	result := make(map[string]any)
	for key, value := range fallback {
		result[key] = value
	}
	if savedCwd != nil && strings.TrimSpace(*savedCwd) != "" {
		result["cwd"] = strings.TrimSpace(*savedCwd)
		delete(result, "projectWorkspaceId")
	}
	cwd, ok := result["cwd"].(string)
	if !ok || !filepath.IsAbs(cwd) || strings.ContainsRune(cwd, 0) {
		return nil, &Error{Status: 409, Code: "AGENT_ENVIRONMENT_REQUIRED", Message: "Configure a local working directory in agent runtime settings before activation"}
	}
	return result, nil
}

func lifecycleMeta[T any](command AgentLifecycleCommand[T]) agentCommandMeta {
	return agentCommandMeta{command.WorkspaceID, command.CommandType, command.IdempotencyKey, command.RequestHash, command.Principal}
}

func (store *Store) beginAgentCommand(ctx context.Context, meta agentCommandMeta) (pgx.Tx, *AgentLifecycleResult, error) {
	if meta.Principal.Type != "user" || meta.Principal.ID == "" {
		return nil, nil, forbidden("AGENT_LIFECYCLE_FORBIDDEN", "A human Workspace member is required")
	}
	return store.beginLifecycleCommand(ctx, meta, false)
}

func (store *Store) beginCandidateCommand(ctx context.Context, meta agentCommandMeta) (pgx.Tx, *AgentLifecycleResult, error) {
	return store.beginLifecycleCommand(ctx, meta, true)
}

func (store *Store) beginLifecycleCommand(ctx context.Context, meta agentCommandMeta, candidate bool) (pgx.Tx, *AgentLifecycleResult, error) {
	return store.beginLifecycleCommandWithAdmission(ctx, meta, candidate, nil)
}

func (store *Store) beginLifecycleCommandWithAdmission(ctx context.Context, meta agentCommandMeta, candidate bool, admit func(pgx.Tx) error) (pgx.Tx, *AgentLifecycleResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, nil, err
	}
	lockKey := meta.WorkspaceID + "\n" + meta.Principal.Type + "\n" + meta.Principal.ID + "\n" + meta.CommandType + "\n" + meta.IdempotencyKey
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	if admit != nil {
		if err := admit(tx); err != nil {
			_ = tx.Rollback(ctx)
			return nil, nil, err
		}
	}
	var existingHash string
	var response []byte
	err = tx.QueryRow(ctx, `select request_hash,response from verrail_agent_command_receipts where workspace_id=$1 and principal_type=$2 and principal_id=$3 and command_type=$4 and idempotency_key=$5`, meta.WorkspaceID, meta.Principal.Type, meta.Principal.ID, meta.CommandType, meta.IdempotencyKey).Scan(&existingHash, &response)
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
	var scopeErr error
	if candidate {
		scopeErr = assertCandidateLifecycleScope(ctx, tx, meta)
	} else {
		scopeErr = assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: meta.WorkspaceID, Principal: meta.Principal})
	}
	if scopeErr != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, scopeErr
	}
	return tx, nil, nil
}

func assertCandidateLifecycleScope(ctx context.Context, tx pgx.Tx, meta agentCommandMeta) error {
	switch meta.Principal.Type {
	case "user":
		return assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: meta.WorkspaceID, Principal: meta.Principal})
	case "agent":
		var exists bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from agents where id=$1 and company_id=$2)`, meta.Principal.ID, meta.WorkspaceID).Scan(&exists); err != nil {
			return fmt.Errorf("validate Agent candidate scope: %w", err)
		}
		if !exists {
			return forbidden("CANDIDATE_COMMAND_FORBIDDEN", "Agent Principal does not belong to this Workspace")
		}
		return nil
	case "service":
		var exists bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from companies where id=$1 and status='active')`, meta.WorkspaceID).Scan(&exists); err != nil {
			return fmt.Errorf("validate Service candidate scope: %w", err)
		}
		if !exists {
			return forbidden("CANDIDATE_COMMAND_FORBIDDEN", "Service Principal cannot access this Workspace")
		}
		return nil
	default:
		return forbidden("CANDIDATE_COMMAND_FORBIDDEN", "Unsupported candidate Principal")
	}
}

func finishAgentCommand(ctx context.Context, tx pgx.Tx, meta agentCommandMeta, result AgentLifecycleResult, eventType string) error {
	receiptID, _ := NewUUID()
	auditID, _ := NewUUID()
	response, _ := json.Marshal(result)
	payload, _ := json.Marshal(map[string]any{"schemaVersion": SchemaVersion, "resourceType": result.ResourceType, "resourceId": result.ResourceID})
	if _, err := tx.Exec(ctx, `insert into verrail_agent_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,response) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, receiptID, meta.WorkspaceID, meta.Principal.Type, meta.Principal.ID, meta.CommandType, meta.IdempotencyKey, meta.RequestHash, response); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, auditID, meta.WorkspaceID, meta.Principal.Type, meta.Principal.ID, eventType, result.ResourceType, result.ResourceID, meta.IdempotencyKey, payload); err != nil {
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
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, command.WorkspaceID+"\nagent-definition\n"+*command.Input.CompatibilityAgentID); err != nil {
			return AgentLifecycleResult{}, err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from agents where id=$1 and company_id=$2)`, *command.Input.CompatibilityAgentID, command.WorkspaceID).Scan(&exists); err != nil || !exists {
			if err != nil {
				return AgentLifecycleResult{}, err
			}
			return AgentLifecycleResult{}, NotFound()
		}
		var existingID string
		if err := tx.QueryRow(ctx, `select id from verrail_agent_definitions where workspace_id=$1 and compatibility_agent_id=$2 order by created_at limit 1`, command.WorkspaceID, *command.Input.CompatibilityAgentID).Scan(&existingID); err == nil {
			result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: "agent_definition", ResourceID: existingID}
			if err := finishAgentCommand(ctx, tx, meta, result, "agent_definition.reused"); err != nil {
				return result, err
			}
			return result, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return AgentLifecycleResult{}, err
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

func (store *Store) CreateDeployment(ctx context.Context, command AgentLifecycleCommand[CreateDeploymentInput]) (out AgentLifecycleResult, outErr error) {
	defer func() { outErr = activationWriteError(outErr) }()
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
	if _, err := tx.Exec(ctx, `select id from verrail_agent_definitions where id=$1 and workspace_id=$2 for update`, definitionID, command.WorkspaceID); err != nil {
		return AgentLifecycleResult{}, err
	}
	var hasDeployment bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from verrail_deployments where agent_definition_id=$1 and workspace_id=$2 and is_primary)`, definitionID, command.WorkspaceID).Scan(&hasDeployment); err != nil {
		return AgentLifecycleResult{}, err
	}
	if hasDeployment {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "AGENT_DEPLOYMENT_EXISTS", Message: "Select the existing deployment and activate a version instead of creating another deployment"}
	}
	if err := assertActivatableAgentVersion(ctx, tx, command.WorkspaceID, command.Input.AgentVersionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if err := assertPassingEvaluation(ctx, tx, command.WorkspaceID, command.Input.AgentVersionID, command.Input.EvaluationRunID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, command.WorkspaceID+"\ndefault-deployment"); err != nil {
		return AgentLifecycleResult{}, err
	}
	// Historical identities remain available to existing Run references, never to activation.
	if _, err := tx.Exec(ctx, `update verrail_deployments set status='retired',is_default=false,name=case when name=$3 then name || ' [' || id::text || ']' else name end,updated_at=now() where agent_definition_id=$1 and workspace_id=$2 and not is_primary`, definitionID, command.WorkspaceID, command.Input.Name); err != nil {
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
	resolvedConfig, err := resolveDeploymentWorkspace(ctx, tx, command.WorkspaceID, command.Input.RuntimeConfig)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	resolvedConfig, err = activationRuntimeConfig(ctx, tx, command.WorkspaceID, command.Input.AgentVersionID, resolvedConfig)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	config, _ := json.Marshal(resolvedConfig)
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(command.RequestHash+"\n"+string(config))))
	if _, err := tx.Exec(ctx, `insert into verrail_deployments(id,workspace_id,agent_definition_id,name,status,is_default,is_primary,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,'active',$5,true,'user',$6)`, deploymentID, command.WorkspaceID, command.Input.AgentDefinitionID, command.Input.Name, isDefault, command.Principal.ID); err != nil {
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

func assertActivatableAgentVersion(ctx context.Context, tx pgx.Tx, workspaceID, versionID string) error {
	var source, mode, model, runtime string
	if err := tx.QueryRow(ctx, `select coalesce(supply_chain->>'source',''), coalesce(supply_chain->>'mode',''), model,runtime from verrail_agent_versions where id=$1 and workspace_id=$2`, versionID, workspaceID).Scan(&source, &mode, &model, &runtime); err != nil {
		return NotFound()
	}
	if source != "saved_agent_configuration.v2" || strings.TrimSpace(model) == "" || model == "unconfigured" || model == "runtime_default" || (mode != "director_chat" && mode != "compatibility_executor") || (mode == "director_chat" && runtime != "opencode" && runtime != "codex" && runtime != "claude") {
		return &Error{Status: 409, Code: "AGENT_VERSION_REPUBLISH_REQUIRED", Message: "Publish a version with pinned runtime settings before activation"}
	}
	return nil
}

func activationWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01") {
		return &Error{Status: 409, Code: "AGENT_REVISION_CONFLICT", Message: "The effective revision changed concurrently; reload before updating"}
	}
	return err
}

func (store *Store) ReviseDeployment(ctx context.Context, command AgentLifecycleCommand[ReviseDeploymentInput]) (out AgentLifecycleResult, outErr error) {
	defer func() { outErr = activationWriteError(outErr) }()
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
	if err := tx.QueryRow(ctx, `select agent_definition_id,status from verrail_deployments where id=$1 and workspace_id=$2`, command.ResourceID, command.WorkspaceID).Scan(&definitionID, &status); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, NotFound()
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if _, err := tx.Exec(ctx, `select id from verrail_agent_definitions where id=$1 and workspace_id=$2 for update`, definitionID, command.WorkspaceID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if err := tx.QueryRow(ctx, `select status from verrail_deployments where id=$1 for update`, command.ResourceID).Scan(&status); err != nil {
		return AgentLifecycleResult{}, err
	}
	if err := deploymentRevisionGate(command.Input.Action, status); err != nil {
		return AgentLifecycleResult{}, err
	}
	var primaryID string
	if err := tx.QueryRow(ctx, `select coalesce((select id::text from verrail_deployments where agent_definition_id=$1 and workspace_id=$2 and is_primary),'none')`, definitionID, command.WorkspaceID).Scan(&primaryID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if command.Input.Action == "activate" && (primaryID != command.Input.ExpectedPrimaryDeploymentID || primaryID != command.ResourceID) {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "AGENT_BINDING_CONFLICT", Message: "The primary deployment changed; reload before activating"}
	}
	if primaryID != "none" && command.Input.Action != "activate" && (command.Input.Action == "upgrade" || command.Input.Action == "rollback" || command.Input.Action == "resume") {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "AGENT_ACTIVATION_REQUIRED", Message: "Use version activation with an observed revision to update or resume this agent"}
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
	var versionID, evaluationID, currentState, currentRevisionID string
	var configBytes []byte
	var nextNumber int
	if err := tx.QueryRow(ctx, `select agent_version_id,evaluation_run_id,state,runtime_config,revision_number+1,id from verrail_deployment_revisions where deployment_id=$1 order by revision_number desc limit 1`, command.ResourceID).Scan(&versionID, &evaluationID, &currentState, &configBytes, &nextNumber, &currentRevisionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if command.Input.ExpectedDeploymentRevisionID != nil && *command.Input.ExpectedDeploymentRevisionID != currentRevisionID {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "AGENT_REVISION_CONFLICT", Message: "The effective revision changed; reload before updating"}
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
		if err := assertPassingEvaluation(ctx, tx, command.WorkspaceID, versionID, evaluationID); err != nil {
			return AgentLifecycleResult{}, err
		}
		status = "active"
	case "retire":
		newState = "retired"
		status = "retired"
	case "upgrade", "activate":
		versionID = *command.Input.AgentVersionID
		evaluationID = *command.Input.EvaluationRunID
		var candidateDefinition string
		if err := tx.QueryRow(ctx, `select agent_definition_id from verrail_agent_versions where id=$1 and workspace_id=$2`, versionID, command.WorkspaceID).Scan(&candidateDefinition); err != nil {
			return AgentLifecycleResult{}, NotFound()
		}
		if candidateDefinition != definitionID {
			return AgentLifecycleResult{}, validation("AgentVersion does not belong to Deployment definition")
		}
		if command.Input.Action == "activate" {
			if err := assertActivatableAgentVersion(ctx, tx, command.WorkspaceID, versionID); err != nil {
				return AgentLifecycleResult{}, err
			}
		}
		if err := assertPassingEvaluation(ctx, tx, command.WorkspaceID, versionID, evaluationID); err != nil {
			return AgentLifecycleResult{}, err
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
	if command.Input.Action == "activate" {
		if _, err := tx.Exec(ctx, `update verrail_deployments set is_primary=true where id=$1 and workspace_id=$2`, command.ResourceID, command.WorkspaceID); err != nil {
			return AgentLifecycleResult{}, err
		}
	}
	if command.Input.RuntimeConfig != nil {
		resolvedConfig, err := resolveDeploymentWorkspace(ctx, tx, command.WorkspaceID, command.Input.RuntimeConfig)
		if err != nil {
			return AgentLifecycleResult{}, err
		}
		configBytes, _ = json.Marshal(resolvedConfig)
	}
	if command.Input.Action == "activate" {
		var previousConfig map[string]any
		if err := json.Unmarshal(configBytes, &previousConfig); err != nil {
			return AgentLifecycleResult{}, err
		}
		config, err := activationRuntimeConfig(ctx, tx, command.WorkspaceID, versionID, previousConfig)
		if err != nil {
			return AgentLifecycleResult{}, err
		}
		configBytes, _ = json.Marshal(config)
	}
	revisionID, _ := NewUUID()
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(command.RequestHash+"\n"+string(configBytes))))
	if _, err := tx.Exec(ctx, `insert into verrail_deployment_revisions(id,workspace_id,deployment_id,revision_number,agent_version_id,evaluation_run_id,state,runtime_config,content_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'user',$10)`, revisionID, command.WorkspaceID, command.ResourceID, nextNumber, versionID, evaluationID, newState, configBytes, digest, command.Principal.ID); err != nil {
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
