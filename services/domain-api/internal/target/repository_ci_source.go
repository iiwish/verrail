package target

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const fixedCIRepositoryExecutor = "verrail-repository-runner"

// Runtime authority comes from the persisted Attempt, never the proof request.
// The original native validator retains its separate receipt and identity rules.
func validateFixedCISource(ctx context.Context, tx pgx.Tx, p FixedCIProofTrustProfile, input FixedCIProofInput) (string, error) {
	var profile, executor string
	err := tx.QueryRow(ctx, `select runtime_profile,executor_principal_id from verrail_run_attempts
		where workspace_id=$1 and run_id=$2 and id=$3 and executor_principal_type='service'
		for share`, p.WorkspaceID, input.Source.RunID, input.Source.RunAttemptID).Scan(&profile, &executor)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fixedCIProofMismatch()
	}
	if err != nil {
		return "", err
	}
	switch {
	case profile == "host_trusted" && executor == fixedCINativeExecutor:
		return validateFixedCINativeSource(ctx, tx, p, input)
	case profile == "repository_sandbox" && executor == fixedCIRepositoryExecutor:
		return validateFixedCIRepositorySource(ctx, tx, p, input)
	default:
		return "", fixedCIProofMismatch()
	}
}

type repositoryCIIdentity struct {
	WorkspaceID          string `json:"workspaceId"`
	TargetID             string `json:"targetId"`
	TargetRevisionID     string `json:"targetRevisionId"`
	GraphRevisionID      string `json:"graphRevisionId"`
	WorkNodeID           string `json:"workNodeId"`
	RunID                string `json:"runId"`
	RunAttemptID         string `json:"runAttemptId"`
	LeaseID              string `json:"leaseId"`
	FencingToken         int64  `json:"fencingToken"`
	AgentVersionID       string `json:"agentVersionId"`
	DeploymentRevisionID string `json:"deploymentRevisionId"`
}

type repositoryCIInputSource struct {
	ArtifactID  string `json:"artifactId"`
	ContentHash string `json:"contentHash"`
	BaseCommit  string `json:"baseCommit"`
	Format      string `json:"format"`
}

type repositoryCIOutputLimits struct {
	MaxFiles      int   `json:"maxFiles"`
	MaxFileBytes  int64 `json:"maxFileBytes"`
	MaxTotalBytes int64 `json:"maxTotalBytes"`
}

// Field order is the shared Zod schema's JSON.stringify order, not JSONB order.
type repositoryCIRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	repositoryCIIdentity
	Source         repositoryCIInputSource  `json:"source"`
	Runtime        string                   `json:"runtime"`
	Model          string                   `json:"model"`
	Instructions   string                   `json:"instructions"`
	TimeoutSeconds int                      `json:"timeoutSeconds"`
	Output         repositoryCIOutputLimits `json:"output"`
}

type repositoryCISourceObservation struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	Phase         string `json:"phase"`
	Status        string `json:"status"`
	ObservedAt    string `json:"observedAt"`
	ScopeVersion  int    `json:"scopeVersion"`
	Repository    struct {
		HeadCommit   string `json:"headCommit"`
		HeadTree     string `json:"headTree"`
		ObjectFormat string `json:"objectFormat"`
	} `json:"repository"`
	Manifest struct {
		SHA256        string `json:"sha256"`
		ContentSHA256 string `json:"contentSha256"`
		Files         int64  `json:"files"`
		DeletedFiles  int64  `json:"deletedFiles"`
		Bytes         int64  `json:"bytes"`
	} `json:"manifest"`
}

type repositoryCIArtifact struct {
	Ordinal        int    `json:"ordinal"`
	Path           string `json:"path"`
	Type           string `json:"type"`
	Kind           string `json:"kind"`
	Title          string `json:"title"`
	Bytes          int64  `json:"bytes"`
	ContentHash    string `json:"contentHash"`
	ContentRef     string `json:"contentRef"`
	SourceSnapshot *struct {
		SchemaVersion       int    `json:"schemaVersion"`
		Format              string `json:"format"`
		ScopeVersion        int    `json:"scopeVersion"`
		SourceContentSHA256 string `json:"sourceContentSha256"`
		SnapshotCommit      string `json:"snapshotCommit"`
		SnapshotTree        string `json:"snapshotTree"`
	} `json:"sourceSnapshot,omitempty"`
}

type repositoryCIExecutionFacts struct {
	Runtime        string `json:"runtime"`
	RuntimeVersion string `json:"runtimeVersion"`
	Model          string `json:"model"`
	RequestSHA256  string `json:"requestSha256"`
	ExitCode       int    `json:"exitCode"`
	StartedAt      string `json:"startedAt"`
	FinishedAt     string `json:"finishedAt"`
	Cleanup        struct {
		Runtime  bool `json:"runtime"`
		Commands bool `json:"commands"`
		Home     bool `json:"home"`
		Checkout bool `json:"checkout"`
	} `json:"cleanup"`
}

type repositoryCISourceBinding struct {
	RepositorySourceRevisionID string `json:"repositorySourceRevisionId"`
	ProvenanceContentHash      string `json:"provenanceContentHash"`
}

type repositoryCIExecutionObservation struct {
	ContentHash string `json:"contentHash"`
	ContentRef  string `json:"contentRef"`
	Bytes       int64  `json:"bytes"`
}

type repositoryCIOutputReceipt struct {
	SchemaVersion        int                               `json:"schemaVersion"`
	Kind                 string                            `json:"kind"`
	Phase                string                            `json:"phase"`
	Identity             repositoryCIIdentity              `json:"identity"`
	RequestSHA256        string                            `json:"requestSha256"`
	InputSource          repositoryCIInputSource           `json:"inputSource"`
	SourceBinding        repositoryCISourceBinding         `json:"sourceBinding"`
	ExecutionFacts       repositoryCIExecutionFacts        `json:"executionFacts"`
	ExecutionObservation *repositoryCIExecutionObservation `json:"executionObservation,omitempty"`
	SourceBefore         repositoryCISourceObservation     `json:"sourceBefore"`
	SourceAfter          repositoryCISourceObservation     `json:"sourceAfter"`
	SourceStatus         string                            `json:"sourceStatus"`
	CollectionStatus     string                            `json:"collectionStatus"`
	Artifacts            []repositoryCIArtifact            `json:"artifacts"`
	FinalizedAt          string                            `json:"finalizedAt"`
	SHA256               string                            `json:"sha256"`
}

type repositoryCIOutput struct {
	RunID         string                    `json:"runId"`
	RunAttemptID  string                    `json:"runAttemptId"`
	LeaseID       string                    `json:"leaseId"`
	FencingToken  int64                     `json:"fencingToken"`
	Source        repositoryCIInputSource   `json:"source"`
	Artifacts     []repositoryCIArtifact    `json:"artifacts"`
	OutputReceipt repositoryCIOutputReceipt `json:"outputReceipt"`
}

type repositoryCISourceProjection struct {
	Identity                                           repositoryCIIdentity
	SourceBinding                                      repositoryCISourceBinding
	Title, ContentHash, ContentRef, Model, RequestHash string
	Event, DispatchInput, DispatchResult               json.RawMessage
}

func validateFixedCIRepositorySource(ctx context.Context, tx pgx.Tx, p FixedCIProofTrustProfile, input FixedCIProofInput) (string, error) {
	facts := repositoryCISourceProjection{Identity: repositoryCIIdentity{
		WorkspaceID: p.WorkspaceID, TargetID: p.TargetID, TargetRevisionID: p.TargetRevisionID,
		GraphRevisionID: p.GraphRevisionID, RunID: input.Source.RunID, RunAttemptID: input.Source.RunAttemptID,
	}}
	err := tx.QueryRow(ctx, `select artifact.title,revision.content_hash,revision.content_ref,run.work_node_id,
		attempt.deployment_revision_id,attempt.agent_version_id,attempt.fencing_token,lease.id,
		version.model,dispatch.request_hash,event.payload,dispatch.input,dispatch.result,
		bound.repository_source_revision_id,provenance.content_hash
		from verrail_artifact_revisions revision
		join verrail_artifacts artifact on artifact.id=revision.artifact_id and artifact.workspace_id=revision.workspace_id
		  and artifact.target_id=$3 and artifact.kind='code_change'
		  and artifact.created_by_principal_type='service' and artifact.created_by_principal_id=$9
		join verrail_runs run on run.id=revision.source_run_id and run.workspace_id=revision.workspace_id
		  and run.id=$4 and run.work_node_id=revision.source_work_node_id and run.target_id=$3
		  and run.target_revision_id=$7 and run.graph_revision_id=$8 and run.status='succeeded' and run.kind='agent'
		join verrail_work_nodes node on node.id=run.work_node_id and node.workspace_id=run.workspace_id
		  and node.target_id=run.target_id and node.graph_revision_id=run.graph_revision_id
		  and node.kind='agent_task' and node.status='completed'
		join verrail_run_attempts attempt on attempt.id=$5 and attempt.run_id=run.id and attempt.workspace_id=run.workspace_id
		  and attempt.status='succeeded' and attempt.executor_principal_type='service' and attempt.executor_principal_id=$9
		  and attempt.runtime_profile='repository_sandbox' and attempt.attempt_number=run.attempt_count
		  and attempt.deployment_revision_id=run.deployment_revision_id and attempt.agent_version_id=run.agent_version_id
		join verrail_deployment_revisions deployment on deployment.id=attempt.deployment_revision_id
		  and deployment.workspace_id=run.workspace_id and deployment.agent_version_id=attempt.agent_version_id
		join verrail_agent_versions version on version.id=attempt.agent_version_id and version.workspace_id=run.workspace_id
		  and version.runtime='opencode'
		join verrail_execution_leases lease on lease.run_attempt_id=attempt.id and lease.workspace_id=run.workspace_id
		  and lease.run_id=run.id and lease.fencing_token=attempt.fencing_token and lease.runtime_profile=attempt.runtime_profile
		  and lease.executor_principal_id=attempt.executor_principal_id and lease.status='released' and lease.released_at is not null
		join verrail_repository_dispatches dispatch on dispatch.run_attempt_id=attempt.id and dispatch.workspace_id=run.workspace_id
		  and dispatch.run_id=run.id and dispatch.lease_id=lease.id and dispatch.fencing_token=lease.fencing_token
		  and dispatch.status='succeeded' and dispatch.finished_at is not null and dispatch.error_code is null
		join verrail_run_sources bound on bound.run_id=run.id and bound.workspace_id=run.workspace_id
		join verrail_artifact_revisions provenance on provenance.id=bound.repository_source_revision_id and provenance.workspace_id=run.workspace_id
		join verrail_artifacts provenance_artifact on provenance_artifact.id=provenance.artifact_id
		  and provenance_artifact.workspace_id=run.workspace_id and provenance_artifact.target_id=run.target_id and provenance_artifact.kind='report'
		join verrail_run_events event on event.id=$6 and event.workspace_id=run.workspace_id and event.run_id=run.id
		  and event.run_attempt_id=attempt.id and event.event_type='succeeded' and event.fencing_token=attempt.fencing_token
		  and event.cursor=attempt.last_event_cursor and event.content_hash=$10
		where revision.workspace_id=$1 and revision.id=$2 and revision.revision_number=1
		  and revision.created_by_principal_type='service' and revision.created_by_principal_id=$9
		  and provenance.content_ref='storage:'||run.workspace_id::text||'/verrail/run-artifacts/sha256/'||provenance.content_hash
		  and exists(select 1 from verrail_artifacts source_artifact join verrail_artifact_revisions source_revision
		    on source_revision.artifact_id=source_artifact.id and source_revision.workspace_id=source_artifact.workspace_id
		    where source_artifact.workspace_id=run.workspace_id and source_artifact.target_id=run.target_id and source_artifact.kind='code_change'
		      and source_artifact.id::text=dispatch.input->'source'->>'artifactId'
		      and source_revision.content_hash=dispatch.input->'source'->>'contentHash'
		      and source_revision.content_ref='storage:'||run.workspace_id::text||'/verrail/run-artifacts/sha256/'||source_revision.content_hash)
		  and not exists(select 1 from verrail_run_attempts newer where newer.workspace_id=run.workspace_id
		    and newer.run_id=run.id and newer.attempt_number>attempt.attempt_number)
		  and (select count(*) from verrail_run_events terminal where terminal.workspace_id=run.workspace_id
		    and terminal.run_id=run.id and terminal.run_attempt_id=attempt.id and terminal.event_type='succeeded')=1
		for share of run,attempt,lease,dispatch,bound,provenance`,
		p.WorkspaceID, input.ArtifactRevisionID, p.TargetID, input.Source.RunID, input.Source.RunAttemptID,
		input.Source.RunEventID, p.TargetRevisionID, p.GraphRevisionID, fixedCIRepositoryExecutor, input.Source.RunEventContentHash).
		Scan(&facts.Title, &facts.ContentHash, &facts.ContentRef, &facts.Identity.WorkNodeID,
			&facts.Identity.DeploymentRevisionID, &facts.Identity.AgentVersionID, &facts.Identity.FencingToken,
			&facts.Identity.LeaseID, &facts.Model, &facts.RequestHash, &facts.Event, &facts.DispatchInput, &facts.DispatchResult,
			&facts.SourceBinding.RepositorySourceRevisionID, &facts.SourceBinding.ProvenanceContentHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fixedCIProofMismatch()
	}
	if err != nil {
		return "", err
	}
	if !validateRepositoryCIProjection(facts, input, time.Now()) {
		return "", fixedCIProofMismatch()
	}
	expectedAudit, err := json.Marshal(map[string]any{"schemaVersion": 1, "resourceType": "artifact_revision", "resourceId": input.ArtifactRevisionID,
		"runId": input.Source.RunID, "runAttemptId": input.Source.RunAttemptID, "workNodeId": facts.Identity.WorkNodeID,
		"fencingToken": facts.Identity.FencingToken, "contentHash": facts.ContentHash})
	if err != nil {
		return "", err
	}
	var auditCount, matchingAuditCount int
	err = tx.QueryRow(ctx, `select count(*),count(*) filter(where payload=$5::jsonb) from verrail_audit_events
		where workspace_id=$1 and principal_type='service' and principal_id=$2 and event_type=$3
		and aggregate_type='artifact_revision' and aggregate_id=$4`,
		p.WorkspaceID, fixedCIRepositoryExecutor, assuranceArtifactRevisionAddedEvent, input.ArtifactRevisionID, expectedAudit).
		Scan(&auditCount, &matchingAuditCount)
	if err != nil {
		return "", err
	}
	if auditCount != 1 || matchingAuditCount != 1 {
		return "", fixedCIProofMismatch()
	}
	return facts.ContentHash, nil
}

func repositoryCIRequestHash(request repositoryCIRequest) (string, error) {
	raw, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var output bytes.Buffer
	var encode func() error
	encode = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		if delimiter, ok := token.(json.Delim); ok {
			output.WriteRune(rune(delimiter))
			for index := 0; decoder.More(); index++ {
				if index > 0 {
					output.WriteByte(',')
				}
				if delimiter == '{' {
					if err := encode(); err != nil {
						return err
					}
					output.WriteByte(':')
				}
				if err := encode(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			output.WriteRune(rune(end.(json.Delim)))
			return nil
		}
		encoded, err := repositoryCIJSON(token)
		if err == nil {
			output.Write(encoded)
		}
		return err
	}
	if err := encode(); err != nil {
		return "", err
	}
	digest := sha256.Sum256(output.Bytes())
	return hex.EncodeToString(digest[:]), nil
}

// Receipt objects have a closed ASCII-key schema. Values retain JSON.stringify
// string escaping, including literal HTML characters and U+2028/U+2029.
func repositoryCIJSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil, err
	}
	var output bytes.Buffer
	var encode func(any) error
	quote := func(value string) error {
		if !utf8.ValidString(value) {
			return errors.New("invalid UTF-8")
		}
		output.WriteByte('"')
		for _, r := range value {
			switch r {
			case '"', '\\':
				output.WriteByte('\\')
				output.WriteRune(r)
			case '\b':
				output.WriteString(`\b`)
			case '\f':
				output.WriteString(`\f`)
			case '\n':
				output.WriteString(`\n`)
			case '\r':
				output.WriteString(`\r`)
			case '\t':
				output.WriteString(`\t`)
			default:
				if r < 0x20 {
					fmt.Fprintf(&output, `\u%04x`, r)
				} else {
					output.WriteRune(r)
				}
			}
		}
		output.WriteByte('"')
		return nil
	}
	encode = func(value any) error {
		switch value := value.(type) {
		case map[string]any:
			keys := make([]string, 0, len(value))
			for key := range value {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			output.WriteByte('{')
			for index, key := range keys {
				if index > 0 {
					output.WriteByte(',')
				}
				if err := quote(key); err != nil {
					return err
				}
				output.WriteByte(':')
				if err := encode(value[key]); err != nil {
					return err
				}
			}
			output.WriteByte('}')
		case []any:
			output.WriteByte('[')
			for index, child := range value {
				if index > 0 {
					output.WriteByte(',')
				}
				if err := encode(child); err != nil {
					return err
				}
			}
			output.WriteByte(']')
		case string:
			return quote(value)
		case json.Number:
			number, err := value.Float64()
			if err != nil || math.IsInf(number, 0) || math.IsNaN(number) || math.Trunc(number) != number || math.Abs(number) > 9007199254740991 {
				return errors.New("non-safe integer")
			}
			if number == 0 {
				output.WriteByte('0')
			} else {
				output.WriteString(strconv.FormatFloat(number, 'f', 0, 64))
			}
		case bool:
			output.WriteString(strconv.FormatBool(value))
		case nil:
			output.WriteString("null")
		default:
			return errors.New("unsupported JSON value")
		}
		return nil
	}
	if err := encode(parsed); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func repositoryCIReceiptHash(receipt repositoryCIOutputReceipt) (string, error) {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return "", err
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	delete(value, "sha256")
	canonical, err := repositoryCIJSON(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

// Unlike the older fixed-wire helper, recurse through artifact arrays as well.
// This rejects omitted zero-valued fields, aliases, nulls and unknown keys.
func decodeRepositoryCIJSON(raw []byte, output any) error {
	return decodeRepositoryCIJSONBound(raw, output, 1024*1024)
}

func decodeRepositoryCIJSONBound(raw []byte, output any, maximum int) error {
	if len(raw) == 0 || len(raw) > maximum || strictFixedCIJSON(raw, output) != nil {
		return fixedCIProofMismatch()
	}
	canonical, err := json.Marshal(output)
	if err != nil {
		return err
	}
	var actual, expected any
	if json.Unmarshal(raw, &actual) != nil || json.Unmarshal(canonical, &expected) != nil {
		return fixedCIProofMismatch()
	}
	var fields func(any, any) bool
	fields = func(actual, expected any) bool {
		switch expected := expected.(type) {
		case map[string]any:
			actual, ok := actual.(map[string]any)
			if !ok || len(actual) != len(expected) {
				return false
			}
			for key, child := range expected {
				value, exists := actual[key]
				if !exists || !fields(value, child) {
					return false
				}
			}
		case []any:
			actual, ok := actual.([]any)
			if !ok || len(actual) != len(expected) {
				return false
			}
			for index, child := range expected {
				if !fields(actual[index], child) {
					return false
				}
			}
		}
		return true
	}
	if !fields(actual, expected) {
		return fixedCIProofMismatch()
	}
	return nil
}

var repositoryCIVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
var repositoryCIPathPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`)

func repositoryCIUTF16Length(value string) int {
	length := 0
	for _, r := range value {
		length++
		if r > 0xffff {
			length++
		}
	}
	return length
}

func repositoryCIModelValid(value string) bool {
	slash := strings.IndexByte(value, '/')
	if slash < 1 || slash == len(value)-1 || repositoryCIUTF16Length(value) > 200 {
		return false
	}
	for _, r := range value {
		if unicode.IsSpace(r) || r == '\ufeff' {
			return false
		}
	}
	return true
}

func validateRepositoryCIProjection(facts repositoryCISourceProjection, input FixedCIProofInput, now time.Time) bool {
	var event struct {
		RepositoryOutput json.RawMessage `json:"repositoryOutput"`
		Artifacts        json.RawMessage `json:"artifacts"`
	}
	if json.Unmarshal(facts.Event, &event) != nil || len(event.RepositoryOutput) == 0 ||
		proofHash(event.RepositoryOutput) != proofHash(facts.DispatchResult) {
		return false
	}
	var registeredArtifacts []RunArtifactInput
	if decodeRepositoryCIJSON(event.Artifacts, &registeredArtifacts) != nil {
		return false
	}
	var result repositoryCIOutput
	if decodeRepositoryCIJSON(event.RepositoryOutput, &result) != nil {
		return false
	}
	r := result.OutputReceipt
	if r.Identity != facts.Identity || r.SourceBinding != facts.SourceBinding ||
		!uuidPattern.MatchString(r.SourceBinding.RepositorySourceRevisionID) || !fixedCIDigestPattern.MatchString(r.SourceBinding.ProvenanceContentHash) ||
		r.SchemaVersion != 1 || r.Kind != "verrail.repository-output-receipt" ||
		r.Phase != "after_runtime_cleanup" || r.RequestSHA256 != facts.RequestHash || !fixedCIDigestPattern.MatchString(r.RequestSHA256) ||
		r.SourceStatus != "stable" || r.CollectionStatus != "collected" || r.SHA256 != input.Source.OutputReceiptSHA256 ||
		result.RunID != facts.Identity.RunID || result.RunAttemptID != facts.Identity.RunAttemptID ||
		result.LeaseID != facts.Identity.LeaseID || result.FencingToken != facts.Identity.FencingToken ||
		result.Source != r.InputSource || proofHash(result.Artifacts) != proofHash(r.Artifacts) {
		return false
	}
	digest, err := repositoryCIReceiptHash(r)
	if err != nil || digest != r.SHA256 {
		return false
	}
	if observation := r.ExecutionObservation; observation != nil {
		if !fixedCIDigestPattern.MatchString(observation.ContentHash) || observation.Bytes < 1 || observation.Bytes > 65536 ||
			observation.ContentRef != "storage:"+facts.Identity.WorkspaceID+"/verrail/repository-execution-observations/sha256/"+observation.ContentHash {
			return false
		}
	}
	if !uuidPattern.MatchString(r.InputSource.ArtifactID) || !fixedCIDigestPattern.MatchString(r.InputSource.ContentHash) ||
		!fixedCICommitPattern.MatchString(r.InputSource.BaseCommit) || r.InputSource.Format != "git_bundle" {
		return false
	}
	var request repositoryCIRequest
	// A legal 400k UTF-16 instruction string can occupy 2.4MB after JSON
	// escaping. Keep the receipt bound unchanged and allow the request bound.
	if decodeRepositoryCIJSONBound(facts.DispatchInput, &request, 400000*6+8192) != nil {
		return false
	}
	requestHash, err := repositoryCIRequestHash(request)
	if err != nil || requestHash != facts.RequestHash || request.repositoryCIIdentity != r.Identity ||
		request.Source != r.InputSource || request.Runtime != "opencode" || request.Model != facts.Model ||
		request.Kind != "target_repository_execution" || request.SchemaVersion != 1 ||
		request.FencingToken < 1 || request.FencingToken > 2147483647 ||
		request.TimeoutSeconds < 1 || request.TimeoutSeconds > 3600 ||
		len(request.Instructions) == 0 || repositoryCIUTF16Length(request.Instructions) > 400000 ||
		!repositoryCIModelValid(request.Model) {
		return false
	}
	limits := request.Output
	if limits.MaxFiles < 1 || limits.MaxFiles > 10 ||
		limits.MaxFileBytes < 1 || limits.MaxFileBytes > 32*1024*1024 || limits.MaxTotalBytes < limits.MaxFileBytes || limits.MaxTotalBytes > 64*1024*1024 {
		return false
	}
	e := r.ExecutionFacts
	if e.Runtime != "opencode" || !repositoryCIVersionPattern.MatchString(e.RuntimeVersion) || e.Model != facts.Model ||
		e.RequestSHA256 != facts.RequestHash || e.ExitCode != 0 || !e.Cleanup.Runtime || !e.Cleanup.Commands || !e.Cleanup.Home || !e.Cleanup.Checkout {
		return false
	}
	before, after, finalized := r.SourceBefore, r.SourceAfter, r.FinalizedAt
	beforeAt, errBefore := time.Parse(time.RFC3339Nano, before.ObservedAt)
	afterAt, errAfter := time.Parse(time.RFC3339Nano, after.ObservedAt)
	finalAt, errFinal := time.Parse(time.RFC3339Nano, finalized)
	startedAt, errStarted := time.Parse(time.RFC3339Nano, e.StartedAt)
	finishedAt, errFinished := time.Parse(time.RFC3339Nano, e.FinishedAt)
	if errBefore != nil || errAfter != nil || errFinal != nil || errStarted != nil || errFinished != nil ||
		finishedAt.Before(startedAt) || beforeAt.Before(finishedAt) || afterAt.Before(beforeAt) || finalAt.Before(afterAt) || finalAt.After(now.Add(time.Minute)) {
		return false
	}
	for index, source := range []repositoryCISourceObservation{before, after} {
		phase := "before_collection"
		if index == 1 {
			phase = "after_collection"
		}
		if source.SchemaVersion != 1 || source.Kind != "verrail.repository-source-observation" || source.Phase != phase ||
			source.Status != "captured" || source.ScopeVersion != 2 || source.Repository.ObjectFormat != "sha1" ||
			!fixedCICommitPattern.MatchString(source.Repository.HeadCommit) || !fixedCICommitPattern.MatchString(source.Repository.HeadTree) ||
			!fixedCIDigestPattern.MatchString(source.Manifest.SHA256) || !fixedCIDigestPattern.MatchString(source.Manifest.ContentSHA256) ||
			source.Manifest.Files < 0 || source.Manifest.Files > 20000 || source.Manifest.DeletedFiles < 0 || source.Manifest.DeletedFiles > 20000 ||
			source.Manifest.Bytes < 0 || source.Manifest.Bytes > 512*1024*1024 {
			return false
		}
	}
	if before.Repository != after.Repository || before.Manifest != after.Manifest || after.Manifest.ContentSHA256 != input.Mapping.SourceContentSHA256 ||
		len(r.Artifacts) < 1 || len(r.Artifacts) > limits.MaxFiles || len(registeredArtifacts) != len(r.Artifacts) ||
		input.Source.ArtifactOrdinal < 0 || input.Source.ArtifactOrdinal >= len(r.Artifacts) {
		return false
	}
	seen := map[string]bool{}
	var total int64
	matches := 0
	for ordinal, artifact := range r.Artifacts {
		registered := registeredArtifacts[ordinal]
		if artifact.Ordinal != ordinal || !repositoryCIPathPattern.MatchString(artifact.Path) || seen[artifact.Path] ||
			strings.TrimSpace(artifact.Title) != artifact.Title || artifact.Title == "" || len([]rune(artifact.Title)) > 200 ||
			artifact.Bytes < 1 || artifact.Bytes > limits.MaxFileBytes || !fixedCIDigestPattern.MatchString(artifact.ContentHash) ||
			artifact.ContentRef != "storage:"+facts.Identity.WorkspaceID+"/verrail/run-artifacts/sha256/"+artifact.ContentHash ||
			registered.Title != artifact.Title || registered.Kind != artifact.Kind || registered.ContentHash != artifact.ContentHash || registered.ContentRef != artifact.ContentRef {
			return false
		}
		seen[artifact.Path] = true
		total += artifact.Bytes
		switch artifact.Type {
		case "file":
			if artifact.SourceSnapshot != nil || artifact.Kind != "code_change" && artifact.Kind != "report" && artifact.Kind != "document" {
				return false
			}
		case "source_snapshot":
			s := artifact.SourceSnapshot
			if s == nil || artifact.Kind != "code_change" || artifact.Path != "source-"+strconv.Itoa(ordinal)+".bundle" || artifact.Bytes == 0 ||
				s.SchemaVersion != 1 || s.Format != "git_bundle" || s.ScopeVersion != 2 || !fixedCICommitPattern.MatchString(s.SnapshotCommit) ||
				!fixedCICommitPattern.MatchString(s.SnapshotTree) || s.SourceContentSHA256 != after.Manifest.ContentSHA256 {
				return false
			}
		default:
			return false
		}
		if artifact.Title == facts.Title && artifact.Kind == "code_change" && artifact.ContentHash == facts.ContentHash && artifact.ContentRef == facts.ContentRef {
			matches++
		}
	}
	selected := r.Artifacts[input.Source.ArtifactOrdinal]
	return total <= limits.MaxTotalBytes && matches == 1 && selected.Title == facts.Title && selected.ContentHash == facts.ContentHash &&
		selected.ContentRef == facts.ContentRef && selected.Type == "source_snapshot" && selected.SourceSnapshot != nil &&
		selected.SourceSnapshot.SnapshotTree == input.Mapping.SourceSnapshotTreeSHA
}
