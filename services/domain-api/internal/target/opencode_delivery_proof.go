package target

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type openCodeHTTPIdentity struct {
	SessionID      string `json:"sessionId"`
	RuntimeVersion string `json:"runtimeVersion"`
	CreatedAt      string `json:"createdAt"`
	HomeSHA256     string `json:"homeSha256"`
}

type openCodeRuntimeBinding struct {
	Kind                    string               `json:"kind"`
	NativePID               int64                `json:"nativePid"`
	ObserverPID             int64                `json:"observerPid"`
	SessionID               string               `json:"sessionId"`
	ManifestSHA256          string               `json:"manifestSha256"`
	ExecutionIdentitySHA256 string               `json:"executionIdentitySha256"`
	HTTPSession             openCodeHTTPIdentity `json:"httpSession"`
}

type openCodeRuntimeReadback struct {
	CheckedAt   string `json:"checkedAt"`
	Permissions struct {
		Default            string   `json:"default"`
		AllowedTools       []string `json:"allowedTools"`
		SessionRulesSHA256 string   `json:"sessionRulesSha256"`
		ConfigRulesSHA256  string   `json:"configRulesSha256"`
	} `json:"permissions"`
	Environment struct {
		HomeSHA256 string `json:"homeSha256"`
		Directory  string `json:"directory"`
		Config     string `json:"config"`
		State      string `json:"state"`
		Worktree   string `json:"worktree"`
	} `json:"environment"`
	Configuration struct {
		Share            string   `json:"share"`
		Model            string   `json:"model"`
		SmallModel       string   `json:"smallModel"`
		EnabledProviders []string `json:"enabledProviders"`
	} `json:"configuration"`
}

type openCodeExecutionContext struct {
	repositoryCIIdentity
	RequestSHA256        string                           `json:"requestSha256"`
	OutputReceiptSHA256  string                           `json:"outputReceiptSha256"`
	RunEventID           string                           `json:"runEventId"`
	ExecutionObservation repositoryCIExecutionObservation `json:"executionObservation"`
	LogRef               repositoryCIExecutionObservation `json:"logRef"`
	ExecutionWindow      struct {
		StartedAt  string `json:"startedAt"`
		FinishedAt string `json:"finishedAt"`
	} `json:"executionWindow"`
	Runtime            string `json:"runtime"`
	RuntimeVersion     string `json:"runtimeVersion"`
	Model              string `json:"model"`
	ProviderID         string `json:"providerId"`
	ModelID            string `json:"modelId"`
	SessionID          string `json:"sessionId"`
	MessageID          string `json:"messageId"`
	SessionCreatedAt   string `json:"sessionCreatedAt"`
	HealthVerifiedAt   string `json:"healthVerifiedAt"`
	SessionCompletedAt string `json:"sessionCompletedAt"`
	FullHistory        struct {
		SHA256           string `json:"sha256"`
		ProjectionSHA256 string `json:"projectionSha256"`
		Bytes            int64  `json:"bytes"`
		MessageCount     int64  `json:"messageCount"`
		PartCount        int64  `json:"partCount"`
	} `json:"fullHistory"`
	RuntimeWitness struct {
		Before openCodeRuntimeReadback `json:"before"`
		After  openCodeRuntimeReadback `json:"after"`
	} `json:"runtimeWitness"`
	CandidateRuntime openCodeRuntimeBinding `json:"candidateRuntime"`
	UsageStatus      string                 `json:"usageStatus"`
	UsageScope       string                 `json:"usageScope"`
	Usage            struct {
		Total     int64 `json:"total"`
		Input     int64 `json:"input"`
		Output    int64 `json:"output"`
		Reasoning int64 `json:"reasoning"`
		Cache     struct {
			Read  int64 `json:"read"`
			Write int64 `json:"write"`
		} `json:"cache"`
	} `json:"usage"`
	CostStatus      string   `json:"costStatus"`
	CostBasis       string   `json:"costBasis"`
	ReportedCostUSD *float64 `json:"reportedCostUsd"`
	Cleanup         struct {
		Runtime  bool `json:"runtime"`
		Home     bool `json:"home"`
		Commands bool `json:"commands"`
		Checkout bool `json:"checkout"`
	} `json:"cleanup"`
	ContextSHA256 string `json:"contextSha256"`
}

type openCodeCandidateWitness struct {
	SchemaVersion            int     `json:"schemaVersion"`
	Kind                     string  `json:"kind"`
	Component                string  `json:"component"`
	Phase                    string  `json:"phase"`
	SessionID                string  `json:"sessionId"`
	RequestID                *string `json:"requestId"`
	ManifestSHA256           string  `json:"manifestSha256"`
	VerifierBuildSHA256      string  `json:"verifierBuildSha256"`
	ObserverExecutableSHA256 string  `json:"observerExecutableSha256"`
	ConfigurationSHA256      string  `json:"configurationSha256"`
	ObserverPID              int64   `json:"observerPid"`
	Observation              struct {
		SourceKind           string   `json:"sourceKind"`
		ObserverSessionID    string   `json:"observerSessionId"`
		PID                  int64    `json:"pid"`
		CandidateCommit      string   `json:"candidateCommit"`
		ExecutableSHA256     string   `json:"executableSha256"`
		StartedAt            string   `json:"startedAt"`
		ObservedAt           string   `json:"observedAt"`
		ObservationSHA256    string   `json:"observationSha256"`
		SourceManifestSHA256 *string  `json:"sourceManifestSha256"`
		ScriptCount          int      `json:"scriptCount"`
		GeneratedScriptCount int      `json:"generatedScriptCount"`
		FinishedAt           *string  `json:"finishedAt"`
		ExitCode             *int     `json:"exitCode"`
		Signal               *string  `json:"signal"`
		Limitations          []string `json:"limitations"`
	} `json:"observation"`
	ExecutionIdentity *repositoryCIIdentity `json:"executionIdentity"`
	HTTPSession       *openCodeHTTPIdentity `json:"httpSession"`
	Launch            struct {
		RootSHA256        string `json:"rootSha256"`
		ArgvSHA256        string `json:"argvSha256"`
		EnvironmentSHA256 string `json:"environmentSha256"`
	} `json:"launch"`
	Termination *struct {
		RequestedSignal            string `json:"requestedSignal"`
		FinishedAt                 string `json:"finishedAt"`
		ProcessGroupStopped        bool   `json:"processGroupStopped"`
		ImmutableExecutableRemoved bool   `json:"immutableExecutableRemoved"`
	} `json:"termination"`
	EnvelopeRef repositoryCIExecutionObservation `json:"envelopeRef"`
}

type openCodeRuntimeProof struct {
	SchemaVersion  int                        `json:"schemaVersion"`
	Kind           string                     `json:"kind"`
	SessionID      string                     `json:"sessionId"`
	ManifestSHA256 string                     `json:"manifestSha256"`
	Witnesses      []openCodeCandidateWitness `json:"witnesses"`
}

type openCodeDeliveryObservation struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	References    struct {
		IdempotencyKey string `json:"idempotencyKey"`
		Kind           string `json:"kind"`
		CI             struct {
			RunID              string `json:"runId"`
			RunAttempt         int64  `json:"runAttempt"`
			ClaimID            string `json:"claimId"`
			WorkNodeID         string `json:"workNodeId"`
			ArtifactRevisionID string `json:"artifactRevisionId"`
			RequirementID      string `json:"requirementId"`
		} `json:"ci"`
		Execution struct {
			RunID        string `json:"runId"`
			RunAttemptID string `json:"runAttemptId"`
		} `json:"execution"`
	} `json:"references"`
	Runtime   openCodeRuntimeProof     `json:"runtime"`
	Channel   *struct{}                `json:"channel"`
	Execution openCodeExecutionContext `json:"execution"`
	CI        struct {
		Kind                 string `json:"kind"`
		SchemaVersion        int    `json:"schemaVersion"`
		Repository           string `json:"repository"`
		RepositoryID         int64  `json:"repositoryId"`
		ProviderRunID        string `json:"providerRunId"`
		ProviderAttempt      int64  `json:"providerAttempt"`
		WorkflowExecutionSHA string `json:"workflowExecutionSha"`
		TestedCandidateSHA   string `json:"testedCandidateSha"`
		WorkflowPath         string `json:"workflowPath"`
		WorkflowSHA256       string `json:"workflowSha256"`
		HelperSHA256         string `json:"helperSha256"`
		ArtifactID           string `json:"artifactId"`
		ArchiveSHA256        string `json:"archiveSha256"`
		ReportSHA256         string `json:"reportSha256"`
		VerifiedAt           string `json:"verifiedAt"`
		Reference            string `json:"reference"`
		Checks               []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"checks"`
		UnsupportedObligations []string `json:"unsupportedObligations"`
		ReceiptSHA256          string   `json:"receiptSha256"`
	} `json:"ci"`
	SourceContextSHA256 string   `json:"sourceContextSha256"`
	Assurance           string   `json:"assurance"`
	Limitations         []string `json:"limitations"`
}

func validateOpenCodeRuntimeProof(runtime openCodeRuntimeProof, e openCodeExecutionContext, payload DeliveryProofPayload) bool {
	if runtime.SchemaVersion != 1 || runtime.Kind != "verrail.opencode-candidate-runtime-proof" ||
		runtime.SessionID != e.CandidateRuntime.SessionID || !uuidPattern.MatchString(runtime.SessionID) ||
		runtime.ManifestSHA256 != payload.RuntimeManifestSHA256 || len(runtime.Witnesses) != 4 {
		return false
	}
	seen := map[string]bool{}
	for _, witness := range runtime.Witnesses {
		o := witness.Observation
		if seen[witness.Component] || (witness.Component != "server" && witness.Component != "domain" && witness.Component != "repository_executor" && witness.Component != "opencode") ||
			witness.SchemaVersion != 1 || witness.Kind != "verrail.opencode-candidate-runtime-witness-summary" ||
			witness.SessionID != runtime.SessionID || witness.ManifestSHA256 != runtime.ManifestSHA256 || witness.ObserverPID < 1 ||
			!uuidPattern.MatchString(o.ObserverSessionID) || o.PID < 1 || o.CandidateCommit != payload.Source.CI.TestedCommit ||
			!openCodeTimesOrdered(o.StartedAt, o.ObservedAt, payload.VerifiedAt) || o.FinishedAt != nil || o.ExitCode != nil || o.Signal != nil ||
			o.Limitations == nil || len(o.Limitations) > 8 || o.ScriptCount < 0 || o.ScriptCount > 10000 || o.GeneratedScriptCount < 0 || o.GeneratedScriptCount > 256 ||
			witness.EnvelopeRef.Bytes < 1 || witness.EnvelopeRef.Bytes > 1024*1024 ||
			witness.EnvelopeRef.ContentRef != "private-witness:sha256:"+witness.EnvelopeRef.ContentHash {
			return false
		}
		seen[witness.Component] = true
		for _, hash := range []string{witness.VerifierBuildSHA256, witness.ObserverExecutableSHA256, witness.ConfigurationSHA256,
			o.ExecutableSHA256, o.ObservationSHA256, witness.Launch.RootSHA256, witness.Launch.ArgvSHA256, witness.Launch.EnvironmentSHA256, witness.EnvelopeRef.ContentHash} {
			if !fixedCIDigestPattern.MatchString(hash) {
				return false
			}
		}
		for _, limitation := range o.Limitations {
			if len(limitation) < 1 || repositoryCIUTF16Length(limitation) > 128 {
				return false
			}
		}
		if witness.Component == "server" || witness.Component == "repository_executor" {
			if o.SourceKind != "verrail.node-runtime-observation" || o.SourceManifestSHA256 == nil || !fixedCIDigestPattern.MatchString(*o.SourceManifestSHA256) || o.ScriptCount < 1 {
				return false
			}
		} else if o.SourceKind != "verrail.native-runtime-observation" || o.SourceManifestSHA256 != nil || o.ScriptCount != 0 || o.GeneratedScriptCount != 0 {
			return false
		}
		if witness.Component == "opencode" {
			if witness.Phase != "terminated" || witness.RequestID != nil || witness.Termination == nil || witness.ExecutionIdentity == nil ||
				*witness.ExecutionIdentity != e.repositoryCIIdentity || witness.HTTPSession == nil || *witness.HTTPSession != e.CandidateRuntime.HTTPSession ||
				witness.ObserverPID != e.CandidateRuntime.ObserverPID || o.PID != e.CandidateRuntime.NativePID ||
				witness.Launch.RootSHA256 != e.CandidateRuntime.HTTPSession.HomeSHA256 ||
				!openCodeTimesOrdered(o.StartedAt, e.SessionCreatedAt, e.SessionCompletedAt, o.ObservedAt, witness.Termination.FinishedAt, e.ExecutionWindow.FinishedAt) ||
				(witness.Termination.RequestedSignal != "SIGTERM" && witness.Termination.RequestedSignal != "SIGINT") ||
				!witness.Termination.ProcessGroupStopped || !witness.Termination.ImmutableExecutableRemoved {
				return false
			}
		} else if witness.Phase != "checkpoint" || witness.RequestID == nil || !uuidPattern.MatchString(*witness.RequestID) ||
			witness.ExecutionIdentity != nil || witness.HTTPSession != nil || witness.Termination != nil ||
			!openCodeTimesOrdered(o.StartedAt, e.ExecutionWindow.StartedAt, e.ExecutionWindow.FinishedAt, o.ObservedAt) {
			return false
		}
	}
	return len(seen) == 4
}

func decodeOpenCodeDeliveryObservation(profile DeliveryProofTrustProfile, payload DeliveryProofPayload) (openCodeDeliveryObservation, error) {
	var observation openCodeDeliveryObservation
	invalid := func() (openCodeDeliveryObservation, error) {
		return observation, validation("DELIVERY_PROOF_ENVELOPE_INVALID")
	}
	if decodeOpenCodeJSON([]byte(payload.ObservationJSON), &observation) != nil {
		return invalid()
	}
	r, ci, s := observation.References, observation.CI, payload.Source
	if observation.SchemaVersion != 1 || observation.Kind != "opencode_execution" || observation.Channel != nil ||
		r.Kind != observation.Kind || r.IdempotencyKey != payload.IdempotencyKey || r.Execution.RunID != s.Source.RunID || r.Execution.RunAttemptID != s.Source.RunAttemptID ||
		r.CI.RunID != s.CI.ProviderRunID || r.CI.RunAttempt != s.CI.ProviderAttempt || r.CI.ClaimID != s.ClaimID || r.CI.WorkNodeID != s.WorkNodeID ||
		r.CI.ArtifactRevisionID != s.ArtifactRevisionID || r.CI.RequirementID != s.RequirementID ||
		!fixedCIDigestPattern.MatchString(observation.SourceContextSHA256) || observation.Assurance != "host_trusted_fixed_verifier" ||
		!reflect.DeepEqual(observation.Limitations, []string{"not_hostile_same_uid_isolation", "runtime_http_readback_not_os_sandbox", "reported_cost_is_not_verified_billing"}) ||
		ci.SchemaVersion != 1 || ci.Kind != "verrail.fixed-ci-observation" || ci.Repository != profile.CI.Repository || ci.RepositoryID != profile.CI.RepositoryID ||
		ci.ProviderRunID != s.CI.ProviderRunID || ci.ProviderAttempt != s.CI.ProviderAttempt || ci.WorkflowExecutionSHA != profile.CI.WorkflowExecutionSHA ||
		ci.TestedCandidateSHA != s.CI.TestedCommit || ci.WorkflowPath != ".github/workflows/verrail-candidate-verify.yml" ||
		ci.WorkflowSHA256 != profile.CI.WorkflowSHA256 || ci.HelperSHA256 != profile.CI.HelperSHA256 || ci.ArtifactID != s.CI.ArtifactID ||
		ci.ArchiveSHA256 != s.CI.ArchiveSHA256 || ci.ReportSHA256 != s.CI.ReportSHA256 || ci.VerifiedAt != s.CI.VerifiedAt || ci.ReceiptSHA256 != s.CI.ObservationSHA256 ||
		ci.Reference != "https://github.com/"+profile.CI.Repository+"/actions/runs/"+ci.ProviderRunID+"/attempts/"+strconv.FormatInt(ci.ProviderAttempt, 10) ||
		len(ci.Checks) != 4 || !reflect.DeepEqual(ci.UnsupportedObligations, []string{"live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"}) ||
		!validateOpenCodeRuntimeProof(observation.Runtime, observation.Execution, payload) {
		return invalid()
	}
	checks := map[string]bool{}
	for _, check := range ci.Checks {
		if checks[check.ID] || check.Status != "passed" || (check.ID != "ts_tests" && check.ID != "ts_typecheck" && check.ID != "ts_build" && check.ID != "go_tests") {
			return invalid()
		}
		checks[check.ID] = true
	}
	return observation, nil
}

// Called inside the same locked admission transaction after repository source
// validation. Signed execution projections cannot substitute a stale dispatch.
func validateOpenCodeDeliveryDatabase(ctx context.Context, tx pgx.Tx, profile DeliveryProofTrustProfile, payload DeliveryProofPayload) error {
	observation, err := decodeOpenCodeDeliveryObservation(profile, payload)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	err = tx.QueryRow(ctx, `select dispatch.result from verrail_repository_dispatches dispatch
		join verrail_run_attempts attempt on attempt.id=dispatch.run_attempt_id and attempt.workspace_id=dispatch.workspace_id and attempt.run_id=dispatch.run_id
		where dispatch.workspace_id=$1 and dispatch.run_id=$2 and dispatch.run_attempt_id=$3 and dispatch.status='succeeded'
		and dispatch.finished_at is not null and dispatch.error_code is null and attempt.runtime_profile='repository_sandbox'
		and attempt.executor_principal_type='service' and attempt.executor_principal_id=$4 for share of dispatch,attempt`,
		payload.WorkspaceID, payload.Source.Source.RunID, payload.Source.Source.RunAttemptID, fixedCIRepositoryExecutor).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return fixedCIProofMismatch()
	}
	if err != nil {
		return err
	}
	var output repositoryCIOutput
	if decodeRepositoryCIJSON(raw, &output) != nil || !validateOpenCodeExecutionContext(observation.Execution, payload, output.OutputReceipt) {
		return fixedCIProofMismatch()
	}
	return nil
}

// OpenCode has explicit nullable observations. Do not relax the older native
// wire decoder: this closed decoder permits null only where the Go shape does.
func decodeOpenCodeJSON(raw []byte, output any) error {
	if len(raw) < 2 || len(raw) > 40000 {
		return errors.New("invalid OpenCode JSON size")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var visit func(int) error
	visit = func(depth int) error {
		if depth > 32 {
			return errors.New("OpenCode JSON nesting exceeded")
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		keys := map[string]bool{}
		for decoder.More() {
			if delimiter == '{' {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || keys[name] {
					return errors.New("duplicate OpenCode JSON field")
				}
				keys[name] = true
			}
			if err := visit(depth + 1); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	}
	if err := visit(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("invalid OpenCode JSON tail")
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	canonical, err := json.Marshal(output)
	if err != nil {
		return err
	}
	var actual, expected any
	if json.Unmarshal(raw, &actual) != nil || json.Unmarshal(canonical, &expected) != nil {
		return errors.New("invalid OpenCode JSON")
	}
	var sameShape func(any, any) bool
	sameShape = func(actual, expected any) bool {
		switch expected := expected.(type) {
		case map[string]any:
			object, ok := actual.(map[string]any)
			if !ok || len(object) != len(expected) {
				return false
			}
			for key, child := range expected {
				value, ok := object[key]
				if !ok || !sameShape(value, child) {
					return false
				}
			}
		case []any:
			array, ok := actual.([]any)
			if !ok || len(array) != len(expected) {
				return false
			}
			for index, child := range expected {
				if !sameShape(array[index], child) {
					return false
				}
			}
		default:
			return reflect.TypeOf(actual) == reflect.TypeOf(expected)
		}
		return true
	}
	if !sameShape(actual, expected) {
		return errors.New("missing or aliased OpenCode JSON field")
	}
	return nil
}

var openCodeSessionPattern = regexp.MustCompile(`^ses_[A-Za-z0-9]{1,124}$`)
var openCodeMessagePattern = regexp.MustCompile(`^msg_[A-Za-z0-9]{1,124}$`)

func openCodeTimesOrdered(values ...string) bool {
	var previous time.Time
	for _, value := range values {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil || parsed.Before(previous) {
			return false
		}
		previous = parsed
	}
	return true
}

func openCodeRefValid(ref repositoryCIExecutionObservation, workspace, namespace string, max int64) bool {
	return fixedCIDigestPattern.MatchString(ref.ContentHash) && ref.Bytes >= 1 && ref.Bytes <= max &&
		ref.ContentRef == "storage:"+workspace+"/verrail/"+namespace+"/sha256/"+ref.ContentHash
}

func validateOpenCodeExecutionContext(e openCodeExecutionContext, payload DeliveryProofPayload, receipt repositoryCIOutputReceipt) bool {
	if e.repositoryCIIdentity != receipt.Identity || e.WorkspaceID != payload.WorkspaceID || e.TargetID != payload.Source.TargetID ||
		e.TargetRevisionID != payload.Source.TargetRevisionID || e.GraphRevisionID != payload.Source.GraphRevisionID ||
		e.RunID != payload.Source.Source.RunID || e.RunAttemptID != payload.Source.Source.RunAttemptID ||
		e.RunEventID != payload.Source.Source.RunEventID || e.OutputReceiptSHA256 != receipt.SHA256 ||
		e.OutputReceiptSHA256 != payload.Source.Source.OutputReceiptSHA256 || e.RequestSHA256 != receipt.RequestSHA256 ||
		receipt.ExecutionObservation == nil || e.ExecutionObservation != *receipt.ExecutionObservation ||
		!openCodeRefValid(e.ExecutionObservation, e.WorkspaceID, "repository-execution-observations", 65536) ||
		!openCodeRefValid(e.LogRef, e.WorkspaceID, "repository-execution-logs", 2*1024*1024) ||
		e.Runtime != "opencode" || e.RuntimeVersion != "1.17.13" || e.RuntimeVersion != receipt.ExecutionFacts.RuntimeVersion ||
		e.Model != receipt.ExecutionFacts.Model || !repositoryCIModelValid(e.Model) || e.Model != e.ProviderID+"/"+e.ModelID ||
		len(e.ProviderID) < 1 || len(e.ProviderID) > 128 || len(e.ModelID) < 1 || repositoryCIUTF16Length(e.ModelID) > 200 ||
		!openCodeSessionPattern.MatchString(e.SessionID) || !openCodeMessagePattern.MatchString(e.MessageID) ||
		e.ExecutionWindow.StartedAt != receipt.ExecutionFacts.StartedAt || e.ExecutionWindow.FinishedAt != receipt.ExecutionFacts.FinishedAt ||
		!fixedCIDigestPattern.MatchString(e.ContextSHA256) || e.FullHistory.SHA256 != e.LogRef.ContentHash ||
		e.FullHistory.Bytes != e.LogRef.Bytes || !fixedCIDigestPattern.MatchString(e.FullHistory.ProjectionSHA256) ||
		e.FullHistory.MessageCount < 2 || e.FullHistory.MessageCount > 1000 || e.FullHistory.PartCount < 0 || e.FullHistory.PartCount > 10000 ||
		e.UsageStatus != "complete" || e.UsageScope != "session-step-finish" || e.CostStatus != "unavailable" || e.CostBasis != "opencode-estimate" ||
		!e.Cleanup.Runtime || !e.Cleanup.Home || !e.Cleanup.Commands || !e.Cleanup.Checkout {
		return false
	}
	for _, count := range []int64{e.Usage.Total, e.Usage.Input, e.Usage.Output, e.Usage.Reasoning, e.Usage.Cache.Read, e.Usage.Cache.Write} {
		if count < 0 || count > 9007199254740991 {
			return false
		}
	}
	if cost := e.ReportedCostUSD; cost != nil && (math.IsNaN(*cost) || math.IsInf(*cost, 0) || *cost < 0) {
		return false
	}
	before, after := e.RuntimeWitness.Before, e.RuntimeWitness.After
	if !openCodeTimesOrdered(e.ExecutionWindow.StartedAt, e.HealthVerifiedAt, e.SessionCreatedAt, before.CheckedAt, e.SessionCompletedAt, after.CheckedAt, e.ExecutionWindow.FinishedAt, receipt.SourceBefore.ObservedAt, receipt.FinalizedAt, payload.VerifiedAt) {
		return false
	}
	before.CheckedAt, after.CheckedAt = "", ""
	if !reflect.DeepEqual(before, after) || before.Permissions.Default != "deny" ||
		!reflect.DeepEqual(before.Permissions.AllowedTools, []string{"repository_execute_command"}) ||
		!fixedCIDigestPattern.MatchString(before.Permissions.SessionRulesSHA256) || !fixedCIDigestPattern.MatchString(before.Permissions.ConfigRulesSHA256) ||
		!fixedCIDigestPattern.MatchString(before.Environment.HomeSHA256) || before.Environment.Directory != "." ||
		before.Environment.Config != "config/opencode" || before.Environment.State != "state/opencode" ||
		(before.Environment.Worktree != "global" && before.Environment.Worktree != "isolated-home") ||
		before.Configuration.Share != "disabled" || before.Configuration.Model != e.Model || before.Configuration.SmallModel != e.Model ||
		len(before.Configuration.EnabledProviders) < 1 || len(before.Configuration.EnabledProviders) > 32 {
		return false
	}
	providers := map[string]bool{}
	for _, provider := range before.Configuration.EnabledProviders {
		if len(provider) < 1 || repositoryCIUTF16Length(provider) > 128 || providers[provider] {
			return false
		}
		providers[provider] = true
	}
	if !providers[e.ProviderID] {
		return false
	}
	binding := e.CandidateRuntime
	identity, err := repositoryCIJSON(e.repositoryCIIdentity)
	if err != nil {
		return false
	}
	digest := sha256.Sum256(identity)
	return binding.Kind == "verrail.opencode-session-bound" && binding.NativePID > 0 && binding.ObserverPID > 0 &&
		uuidPattern.MatchString(binding.SessionID) && binding.ManifestSHA256 == payload.RuntimeManifestSHA256 &&
		binding.ExecutionIdentitySHA256 == hex.EncodeToString(digest[:]) && binding.HTTPSession.SessionID == e.SessionID &&
		binding.HTTPSession.RuntimeVersion == e.RuntimeVersion && binding.HTTPSession.CreatedAt == e.SessionCreatedAt &&
		binding.HTTPSession.HomeSHA256 == before.Environment.HomeSHA256 && !strings.Contains(e.ProviderID, "/")
}
