package target

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

type repositoryRecoveryProcess struct {
	BootID     string `json:"bootId"`
	PID        int64  `json:"pid"`
	PGID       int64  `json:"pgid"`
	SessionID  int64  `json:"sessionId"`
	StartTicks string `json:"startTicks"`
}

type repositoryRecoverySnapshot struct {
	Process              repositoryRecoveryProcess `json:"process"`
	ObserverSessionID    string                    `json:"observerSessionId"`
	CandidateCommit      string                    `json:"candidateCommit"`
	ExecutableSHA256     string                    `json:"executableSha256"`
	SourceManifestSHA256 string                    `json:"sourceManifestSha256"`
	ObservationSHA256    string                    `json:"observationSha256"`
	StartedAt            string                    `json:"startedAt"`
	ObservedAt           string                    `json:"observedAt"`
}

type repositoryRecoveryStopped struct {
	Process          repositoryRecoveryProcess `json:"process"`
	RequestedSignal  string                    `json:"requestedSignal"`
	TermSentAt       string                    `json:"termSentAt"`
	KillSentAt       *string                   `json:"killSentAt"`
	StoppedAt        string                    `json:"stoppedAt"`
	ProcessGroupGone bool                      `json:"processGroupGone"`
	ProcessReaped    bool                      `json:"processReaped"`
}

type repositoryRecoveryProbe struct {
	JournalSHA256  string `json:"journalSha256"`
	RequestSHA256  string `json:"requestSha256"`
	ResponseSHA256 string `json:"responseSha256"`
	Challenge      string `json:"challenge"`
	IssuedAt       string `json:"issuedAt"`
	ReceivedAt     string `json:"receivedAt"`
}

type repositoryRecoveryProof struct {
	SchemaVersion                 int                  `json:"schemaVersion"`
	Kind                          string               `json:"kind"`
	RecoverySessionID             string               `json:"recoverySessionId"`
	Nonce                         string               `json:"nonce"`
	CandidateSessionID            string               `json:"candidateSessionId"`
	RuntimeManifestSHA256         string               `json:"runtimeManifestSha256"`
	ConfigurationSHA256           string               `json:"configurationSha256"`
	Identity                      repositoryCIIdentity `json:"identity"`
	PreRuntimeProofSHA256         string               `json:"preRuntimeProofSha256"`
	AuthorizationSHA256           string               `json:"authorizationSha256"`
	TransitionSHA256              string               `json:"transitionSha256"`
	CompletionAuthorizationSHA256 string               `json:"completionAuthorizationSha256"`
	FinalSHA256                   string               `json:"finalSha256"`
	Before                        struct {
		ContextSHA256              string `json:"contextSha256"`
		ObservedAt                 string `json:"observedAt"`
		DurableSHA256              string `json:"durableSha256"`
		OutputReceiptSHA256        string `json:"outputReceiptSha256"`
		ExecutionObservationSHA256 string `json:"executionObservationSha256"`
		ExecutionLogSHA256         string `json:"executionLogSha256"`
		ExecutionSessionID         string `json:"executionSessionId"`
		ArtifactCount              int    `json:"artifactCount"`
	} `json:"before"`
	After struct {
		ContextSHA256             string `json:"contextSha256"`
		SourceContextSHA256       string `json:"sourceContextSha256"`
		EventsSHA256              string `json:"eventsSha256"`
		ArtifactsSHA256           string `json:"artifactsSha256"`
		AuthoritativeResultSHA256 string `json:"authoritativeResultSha256"`
	} `json:"after"`
	Runtime struct {
		ObserverProcess repositoryRecoveryProcess  `json:"observerProcess"`
		Old             repositoryRecoverySnapshot `json:"old"`
		Next            repositoryRecoverySnapshot `json:"next"`
		OldStopped      repositoryRecoveryStopped  `json:"oldStopped"`
		NextStopped     repositoryRecoveryStopped  `json:"nextStopped"`
		OwnedCleanup    struct {
			ObserverPID               int64  `json:"observerPid"`
			NativePID                 int64  `json:"nativePid"`
			CheckedAt                 string `json:"checkedAt"`
			ProcessGroupsGone         bool   `json:"processGroupsGone"`
			Basis                     string `json:"basis"`
			OutputReceiptSHA256       string `json:"outputReceiptSha256"`
			TerminationEnvelopeSHA256 string `json:"terminationEnvelopeSha256"`
		} `json:"ownedCleanup"`
	} `json:"runtime"`
	Probes struct {
		AuthorizationSHA256   string                  `json:"authorizationSha256"`
		BaselineSHA256        string                  `json:"baselineSha256"`
		StaleCheckpointSHA256 string                  `json:"staleCheckpointSha256"`
		OldAttemptID          string                  `json:"oldAttemptId"`
		OldAttemptNumber      int64                   `json:"oldAttemptNumber"`
		OldLeaseID            string                  `json:"oldLeaseId"`
		OldFencingToken       int64                   `json:"oldFencingToken"`
		NextCursor            int64                   `json:"nextCursor"`
		OldAttemptSHA256      string                  `json:"oldAttemptSha256"`
		OldLeaseSHA256        string                  `json:"oldLeaseSha256"`
		OldEventsSHA256       string                  `json:"oldEventsSha256"`
		CurrentAttemptSHA256  string                  `json:"currentAttemptSha256"`
		CurrentRunSHA256      string                  `json:"currentRunSha256"`
		CurrentLeaseSHA256    string                  `json:"currentLeaseSha256"`
		Duplicate             repositoryRecoveryProbe `json:"duplicate"`
		Stale                 struct {
			repositoryRecoveryProbe
			RequestHash      string               `json:"requestHash"`
			IdempotencyKey   string               `json:"idempotencyKey"`
			ReceiptID        string               `json:"receiptId"`
			ReceiptSHA256    string               `json:"receiptSha256"`
			ReceiptCreatedAt string               `json:"receiptCreatedAt"`
			AuditID          string               `json:"auditId"`
			AuditSHA256      string               `json:"auditSha256"`
			AuditOccurredAt  string               `json:"auditOccurredAt"`
			Response         ReportRunEventResult `json:"response"`
		} `json:"stale"`
	} `json:"probes"`
	Archives struct {
		Before                  repositoryCIExecutionObservation `json:"before"`
		Probe                   repositoryCIExecutionObservation `json:"probe"`
		After                   repositoryCIExecutionObservation `json:"after"`
		Ready                   repositoryCIExecutionObservation `json:"ready"`
		Authorization           repositoryCIExecutionObservation `json:"authorization"`
		Transition              repositoryCIExecutionObservation `json:"transition"`
		ProbeAuthorization      repositoryCIExecutionObservation `json:"probeAuthorization"`
		DuplicateJournal        repositoryCIExecutionObservation `json:"duplicateJournal"`
		StaleJournal            repositoryCIExecutionObservation `json:"staleJournal"`
		CompletionAuthorization repositoryCIExecutionObservation `json:"completionAuthorization"`
		Final                   repositoryCIExecutionObservation `json:"final"`
	} `json:"archives"`
	Limitations []string `json:"limitations"`
}

type repositoryRecoveryObservation struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Kind          string                      `json:"kind"`
	Delivery      openCodeDeliveryObservation `json:"delivery"`
	Recovery      repositoryRecoveryProof     `json:"recovery"`
}

var recoveryTicksPattern = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)

func recoveryProcessValid(p repositoryRecoveryProcess, leader bool) bool {
	return uuidPattern.MatchString(p.BootID) && p.PID > 0 && p.PID <= 4194304 && p.PGID > 0 && p.SessionID > 0 &&
		recoveryTicksPattern.MatchString(p.StartTicks) && (!leader || (p.PID == p.PGID && p.PID == p.SessionID))
}

func recoveryStopValid(s repositoryRecoveryStopped, p repositoryRecoveryProcess) bool {
	if s.Process != p || s.RequestedSignal != "SIGTERM" || !s.ProcessGroupGone || !s.ProcessReaped || !openCodeTimesOrdered(s.TermSentAt, s.StoppedAt) {
		return false
	}
	return s.KillSentAt == nil || openCodeTimesOrdered(s.TermSentAt, *s.KillSentAt, s.StoppedAt)
}

func recoveryProbeValid(p repositoryRecoveryProbe) bool {
	start, a := time.Parse(time.RFC3339Nano, p.IssuedAt)
	end, b := time.Parse(time.RFC3339Nano, p.ReceivedAt)
	return a == nil && b == nil && !end.Before(start) && end.Sub(start) <= 10*time.Second && uuidPattern.MatchString(p.Challenge) &&
		fixedCIDigestPattern.MatchString(p.JournalSHA256) && fixedCIDigestPattern.MatchString(p.RequestSHA256) && fixedCIDigestPattern.MatchString(p.ResponseSHA256)
}

func decodeRepositoryRecoveryObservation(profile DeliveryProofTrustProfile, payload DeliveryProofPayload) (repositoryRecoveryObservation, error) {
	var observation repositoryRecoveryObservation
	invalid := func() (repositoryRecoveryObservation, error) {
		return observation, validation("DELIVERY_PROOF_ENVELOPE_INVALID")
	}
	if decodeOpenCodeJSON([]byte(payload.ObservationJSON), &observation) != nil || observation.SchemaVersion != 1 || observation.Kind != "repository_recovery" {
		return invalid()
	}
	componentBytes, err := json.Marshal(observation.Delivery)
	if err != nil {
		return invalid()
	}
	componentPayload := payload
	componentPayload.ObservationJSON = string(componentBytes)
	if _, err := decodeOpenCodeDeliveryObservation(profile, componentPayload); err != nil {
		return invalid()
	}
	r, e := observation.Recovery, observation.Delivery.Execution
	p, runtime := r.Probes, r.Runtime
	if r.SchemaVersion != 1 || r.Kind != "verrail.repository-recovery-closed-context" || r.Identity != e.repositoryCIIdentity ||
		!uuidPattern.MatchString(r.RecoverySessionID) || !uuidPattern.MatchString(r.Nonce) || r.CandidateSessionID != e.CandidateRuntime.SessionID ||
		r.RuntimeManifestSHA256 != payload.RuntimeManifestSHA256 || r.Before.OutputReceiptSHA256 != e.OutputReceiptSHA256 ||
		r.Before.ExecutionObservationSHA256 != e.ExecutionObservation.ContentHash || r.Before.ExecutionLogSHA256 != e.LogRef.ContentHash ||
		r.Before.ExecutionSessionID != e.SessionID || r.Before.ArtifactCount < 1 || r.Before.ArtifactCount > 10 ||
		p.BaselineSHA256 != r.After.ContextSHA256 ||
		!reflect.DeepEqual(r.Limitations, []string{"not_hostile_same_uid_isolation", "known_detached_groups_only", "command_cleanup_from_candidate_executor_stop_ack", "not_full_host_disaster_recovery"}) {
		return invalid()
	}
	encodedRuntime, err := repositoryCIJSON(observation.Delivery.Runtime)
	if err != nil {
		return invalid()
	}
	digest := sha256.Sum256(encodedRuntime)
	if r.PreRuntimeProofSHA256 != hex.EncodeToString(digest[:]) {
		return invalid()
	}
	for _, value := range []string{r.ConfigurationSHA256, r.AuthorizationSHA256, r.TransitionSHA256, r.CompletionAuthorizationSHA256, r.FinalSHA256,
		r.Before.ContextSHA256, r.Before.DurableSHA256, r.After.ContextSHA256, r.After.SourceContextSHA256, r.After.EventsSHA256,
		r.After.ArtifactsSHA256, r.After.AuthoritativeResultSHA256, p.AuthorizationSHA256, p.StaleCheckpointSHA256,
		p.OldAttemptSHA256, p.OldLeaseSHA256, p.OldEventsSHA256, p.CurrentAttemptSHA256, p.CurrentRunSHA256, p.CurrentLeaseSHA256,
		p.Stale.RequestHash, p.Stale.ReceiptSHA256, p.Stale.AuditSHA256} {
		if !fixedCIDigestPattern.MatchString(value) {
			return invalid()
		}
	}
	for _, ref := range []repositoryCIExecutionObservation{r.Archives.Before, r.Archives.Probe, r.Archives.After, r.Archives.Ready,
		r.Archives.Authorization, r.Archives.Transition, r.Archives.ProbeAuthorization, r.Archives.DuplicateJournal,
		r.Archives.StaleJournal, r.Archives.CompletionAuthorization, r.Archives.Final} {
		if !fixedCIDigestPattern.MatchString(ref.ContentHash) || ref.Bytes < 1 || ref.Bytes > 1024*1024 || ref.ContentRef != "private-recovery:sha256:"+ref.ContentHash {
			return invalid()
		}
	}
	if !recoveryProcessValid(runtime.ObserverProcess, false) || !recoveryProcessValid(runtime.Old.Process, true) ||
		!recoveryProcessValid(runtime.Next.Process, true) || runtime.Old.Process.BootID != runtime.Next.Process.BootID ||
		runtime.ObserverProcess.BootID != runtime.Old.Process.BootID || runtime.Old.Process.PID == runtime.Next.Process.PID ||
		runtime.ObserverProcess.PID == runtime.Old.Process.PID || runtime.ObserverProcess.PID == runtime.Next.Process.PID ||
		!recoveryStopValid(runtime.OldStopped, runtime.Old.Process) || !recoveryStopValid(runtime.NextStopped, runtime.Next.Process) {
		return invalid()
	}
	for _, snapshot := range []repositoryRecoverySnapshot{runtime.Old, runtime.Next} {
		if !uuidPattern.MatchString(snapshot.ObserverSessionID) || snapshot.CandidateCommit != payload.Source.CI.TestedCommit ||
			!fixedCIDigestPattern.MatchString(snapshot.ExecutableSHA256) || !fixedCIDigestPattern.MatchString(snapshot.SourceManifestSHA256) ||
			!fixedCIDigestPattern.MatchString(snapshot.ObservationSHA256) || !openCodeTimesOrdered(snapshot.StartedAt, snapshot.ObservedAt, payload.VerifiedAt) {
			return invalid()
		}
	}
	if runtime.Old.ExecutableSHA256 != runtime.Next.ExecutableSHA256 || runtime.Old.SourceManifestSHA256 != runtime.Next.SourceManifestSHA256 ||
		runtime.Old.ObserverSessionID == runtime.Next.ObserverSessionID ||
		!openCodeTimesOrdered(runtime.Old.StartedAt, e.ExecutionWindow.StartedAt, e.ExecutionWindow.FinishedAt, r.Before.ObservedAt,
			runtime.Old.ObservedAt, runtime.OldStopped.TermSentAt, runtime.OldStopped.StoppedAt, runtime.Next.StartedAt,
			p.Duplicate.IssuedAt, p.Duplicate.ReceivedAt, p.Stale.IssuedAt, p.Stale.ReceivedAt, runtime.Next.ObservedAt,
			runtime.NextStopped.TermSentAt, runtime.NextStopped.StoppedAt, payload.VerifiedAt) {
		return invalid()
	}
	var executor, native *openCodeCandidateWitness
	for index := range observation.Delivery.Runtime.Witnesses {
		witness := &observation.Delivery.Runtime.Witnesses[index]
		if witness.Component == "repository_executor" {
			executor = witness
		}
		if witness.Component == "opencode" {
			native = witness
		}
	}
	cleanup := runtime.OwnedCleanup
	if executor == nil || native == nil || executor.Observation.PID != runtime.Old.Process.PID || executor.ObserverPID != runtime.ObserverProcess.PID ||
		executor.ConfigurationSHA256 != r.ConfigurationSHA256 || executor.Observation.StartedAt != runtime.Old.StartedAt ||
		executor.Observation.ObserverSessionID != runtime.Old.ObserverSessionID ||
		executor.Observation.ExecutableSHA256 != runtime.Old.ExecutableSHA256 || executor.Observation.SourceManifestSHA256 == nil ||
		*executor.Observation.SourceManifestSHA256 != runtime.Old.SourceManifestSHA256 || native.Termination == nil ||
		cleanup.Basis != "candidate_executor_typed_output_receipt_and_signed_opencode_termination" || !cleanup.ProcessGroupsGone ||
		cleanup.OutputReceiptSHA256 != e.OutputReceiptSHA256 || cleanup.TerminationEnvelopeSHA256 != native.EnvelopeRef.ContentHash ||
		cleanup.ObserverPID != native.ObserverPID || cleanup.NativePID != native.Observation.PID ||
		!openCodeTimesOrdered(native.Termination.FinishedAt, runtime.NextStopped.StoppedAt, cleanup.CheckedAt, payload.VerifiedAt) {
		return invalid()
	}
	response := p.Stale.Response
	if !uuidPattern.MatchString(p.OldAttemptID) || !uuidPattern.MatchString(p.OldLeaseID) || p.OldAttemptID == r.Identity.RunAttemptID ||
		p.OldLeaseID == r.Identity.LeaseID || p.OldAttemptNumber < 1 || p.OldFencingToken < 1 || p.OldFencingToken >= r.Identity.FencingToken ||
		p.NextCursor < 3 || p.NextCursor > 4097 || !recoveryProbeValid(p.Duplicate) || !recoveryProbeValid(p.Stale.repositoryRecoveryProbe) ||
		p.Duplicate.Challenge == p.Stale.Challenge || p.Stale.IdempotencyKey != "recovery-stale:"+p.Stale.Challenge ||
		!uuidPattern.MatchString(p.Stale.ReceiptID) || !uuidPattern.MatchString(p.Stale.AuditID) ||
		!openCodeTimesOrdered(p.Stale.IssuedAt, p.Stale.ReceiptCreatedAt, p.Stale.ReceivedAt) ||
		!openCodeTimesOrdered(p.Stale.IssuedAt, p.Stale.AuditOccurredAt, p.Stale.ReceivedAt) ||
		response.SchemaVersion != 1 || response.RunID != r.Identity.RunID || response.RunAttemptID != p.OldAttemptID ||
		response.Cursor != p.NextCursor || response.EventType != "heartbeat" || response.Authoritative || response.Replayed ||
		response.RejectionCode == nil || *response.RejectionCode != "STALE_FENCING_TOKEN" || response.RunStatus != "succeeded" ||
		(response.AttemptStatus != "failed" && response.AttemptStatus != "superseded") || (response.LeaseStatus != "expired" && response.LeaseStatus != "revoked") {
		return invalid()
	}
	issued, _ := time.Parse(time.RFC3339Nano, p.Stale.IssuedAt)
	wire, err := json.Marshal(ReportRunEventInput{LeaseID: p.OldLeaseID, FencingToken: p.OldFencingToken, Cursor: p.NextCursor,
		EventType: "heartbeat", EmittedAt: issued.Truncate(time.Second)})
	if err != nil {
		return invalid()
	}
	requestDigest := sha256.Sum256(wire)
	if p.Stale.RequestHash != hex.EncodeToString(requestDigest[:]) {
		return invalid()
	}
	return observation, nil
}

// The outer trusted-reader signature authenticates the archived observations.
// Admission also rechecks mutable database associations in its existing transaction.
func validateRepositoryRecoveryDatabase(ctx context.Context, tx pgx.Tx, profile DeliveryProofTrustProfile, payload DeliveryProofPayload) error {
	observation, err := decodeRepositoryRecoveryObservation(profile, payload)
	if err != nil {
		return err
	}
	componentBytes, err := json.Marshal(observation.Delivery)
	if err != nil {
		return err
	}
	componentPayload := payload
	componentPayload.ObservationJSON = string(componentBytes)
	if err := validateOpenCodeDeliveryDatabase(ctx, tx, profile, componentPayload); err != nil {
		return err
	}
	r, p := observation.Recovery, observation.Recovery.Probes
	var matches bool
	err = tx.QueryRow(ctx, `select exists(select 1 from verrail_run_attempts old
		join verrail_execution_leases lease on lease.run_attempt_id=old.id and lease.workspace_id=old.workspace_id and lease.run_id=old.run_id
		join verrail_run_attempts current on current.id=$4 and current.workspace_id=old.workspace_id and current.run_id=old.run_id
		join verrail_runs run on run.id=current.run_id and run.workspace_id=current.workspace_id
		where old.workspace_id=$1 and old.run_id=$2 and old.id=$3 and old.attempt_number=$5 and lease.id=$6 and old.fencing_token=$7
		and lease.fencing_token=old.fencing_token and old.attempt_number<current.attempt_number and old.fencing_token<current.fencing_token
		and old.last_event_cursor=$8 and old.status=$9 and lease.status=$10 and old.started_at is not null and old.finished_at is not null
		and old.started_at<=old.finished_at and old.finished_at<=current.started_at and lease.released_at<=current.started_at
		and current.finished_at is not null and run.finished_at is not null and current.status='succeeded' and run.status='succeeded'
		and current.attempt_number=run.attempt_count and old.agent_version_id=current.agent_version_id and old.deployment_revision_id=current.deployment_revision_id
		and old.runtime_profile='repository_sandbox' and old.executor_principal_type='service' and old.executor_principal_id=$11
		and lease.runtime_profile='repository_sandbox' and lease.executor_principal_id=$11
		and not exists(select 1 from verrail_run_events where workspace_id=$1 and run_id=$2 and run_attempt_id=$3 and cursor=$12)
		and (select count(*) from verrail_run_events where workspace_id=$1 and run_id=$2 and run_attempt_id=$3)=$8
		and not exists(select 1 from verrail_run_events where workspace_id=$1 and run_id=$2 and run_attempt_id=$3 and (fencing_token<>$7 or cursor<1 or cursor>$8 or received_at>old.finished_at))
		and exists(select 1 from verrail_run_events where workspace_id=$1 and run_id=$2 and run_attempt_id=$3 and cursor=1 and event_type='claimed')
		and exists(select 1 from verrail_run_events where workspace_id=$1 and run_id=$2 and run_attempt_id=$3 and event_type='started'))`,
		r.Identity.WorkspaceID, r.Identity.RunID, p.OldAttemptID, r.Identity.RunAttemptID, p.OldAttemptNumber, p.OldLeaseID,
		p.OldFencingToken, p.NextCursor-1, p.Stale.Response.AttemptStatus, p.Stale.Response.LeaseStatus, fixedCIRepositoryExecutor, p.NextCursor).Scan(&matches)
	if err != nil {
		return err
	}
	if !matches {
		return fixedCIProofMismatch()
	}
	var response, audit json.RawMessage
	var created, occurred time.Time
	err = tx.QueryRow(ctx, `select receipt.response,receipt.created_at,audit.payload,audit.occurred_at
		from verrail_execution_command_receipts receipt join verrail_audit_events audit on audit.id=$7 and audit.workspace_id=receipt.workspace_id
		and audit.aggregate_type='target' and audit.aggregate_id=$8 and audit.event_type='run.event_rejected_stale_fence'
		and audit.principal_type='service' and audit.principal_id=$2 and audit.idempotency_key=$4
		where receipt.id=$1 and receipt.workspace_id=$3 and receipt.principal_type='service' and receipt.principal_id=$2
		and receipt.command_type='run_event.report.v1' and receipt.idempotency_key=$4 and receipt.request_hash=$5
		and (select count(*) from verrail_audit_events where workspace_id=$3 and aggregate_type='target' and aggregate_id=$8
		and event_type='run.event_rejected_stale_fence' and idempotency_key=$4)=1
		and receipt.created_at<=$6`, p.Stale.ReceiptID, fixedCIRepositoryExecutor, r.Identity.WorkspaceID, p.Stale.IdempotencyKey,
		p.Stale.RequestHash, time.Now().UTC(), p.Stale.AuditID, r.Identity.TargetID).Scan(&response, &created, &audit, &occurred)
	if errors.Is(err, pgx.ErrNoRows) {
		return fixedCIProofMismatch()
	}
	if err != nil {
		return err
	}
	var actualResponse ReportRunEventResult
	if decodeOpenCodeJSON(response, &actualResponse) != nil || !reflect.DeepEqual(actualResponse, p.Stale.Response) ||
		created.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z") != p.Stale.ReceiptCreatedAt ||
		occurred.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z") != p.Stale.AuditOccurredAt {
		return fixedCIProofMismatch()
	}
	expectedAudit := map[string]any{"schemaVersion": 1, "targetId": r.Identity.TargetID, "runId": r.Identity.RunID,
		"runAttemptId": p.OldAttemptID, "eventType": "run.event_rejected_stale_fence"}
	var actualAudit map[string]any
	expectedBytes, _ := json.Marshal(expectedAudit)
	var expectedMap map[string]any
	if json.Unmarshal(audit, &actualAudit) != nil || json.Unmarshal(expectedBytes, &expectedMap) != nil || !reflect.DeepEqual(actualAudit, expectedMap) {
		return fixedCIProofMismatch()
	}
	if err := validateRecoveryDatabaseFingerprints(ctx, tx, r); err != nil {
		return err
	}
	return validateRecoveryRegisteredOutputs(ctx, tx, r)
}

func validateRecoveryRegisteredOutputs(ctx context.Context, tx pgx.Tx, proof repositoryRecoveryProof) error {
	var raw json.RawMessage
	if err := tx.QueryRow(ctx, `select result from verrail_repository_dispatches where workspace_id=$1 and run_id=$2 and run_attempt_id=$3`,
		proof.Identity.WorkspaceID, proof.Identity.RunID, proof.Identity.RunAttemptID).Scan(&raw); err != nil {
		return err
	}
	var output repositoryCIOutput
	if decodeRepositoryCIJSON(raw, &output) != nil || len(output.OutputReceipt.Artifacts) != proof.Before.ArtifactCount {
		return fixedCIProofMismatch()
	}
	unmatched := append([]repositoryCIArtifact(nil), output.OutputReceipt.Artifacts...)
	rows, err := tx.Query(ctx, `select revision.id,artifact.title,artifact.kind,revision.content_hash,revision.content_ref,
		coalesce(artifact.target_id=$3 and artifact.workspace_id=$1 and artifact.created_by_principal_type='service' and artifact.created_by_principal_id=$5
		and revision.revision_number=1 and revision.source_work_node_id=$4 and revision.created_by_principal_type='service' and revision.created_by_principal_id=$5,false)
		from verrail_artifact_revisions revision left join verrail_artifacts artifact on artifact.id=revision.artifact_id
		where revision.workspace_id=$1 and revision.source_run_id=$2 order by revision.id limit 11`, proof.Identity.WorkspaceID,
		proof.Identity.RunID, proof.Identity.TargetID, proof.Identity.WorkNodeID, fixedCIRepositoryExecutor)
	if err != nil {
		return err
	}
	type registration struct{ id, hash string }
	registered := []registration{}
	for rows.Next() {
		var id, title, kind, contentHash, contentRef string
		var valid bool
		if err := rows.Scan(&id, &title, &kind, &contentHash, &contentRef, &valid); err != nil {
			rows.Close()
			return err
		}
		index := -1
		for i, artifact := range unmatched {
			if artifact.Title == title && artifact.Kind == kind && artifact.ContentHash == contentHash && artifact.ContentRef == contentRef {
				index = i
				break
			}
		}
		if !valid || index < 0 {
			rows.Close()
			return fixedCIProofMismatch()
		}
		unmatched = append(unmatched[:index], unmatched[index+1:]...)
		registered = append(registered, registration{id, contentHash})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(unmatched) != 0 || len(registered) != proof.Before.ArtifactCount {
		return fixedCIProofMismatch()
	}
	for _, revision := range registered {
		expected, _ := json.Marshal(map[string]any{"schemaVersion": 1, "resourceType": "artifact_revision", "resourceId": revision.id,
			"runId": proof.Identity.RunID, "runAttemptId": proof.Identity.RunAttemptID, "workNodeId": proof.Identity.WorkNodeID,
			"fencingToken": proof.Identity.FencingToken, "contentHash": revision.hash})
		var count, matching int
		if err := tx.QueryRow(ctx, `select count(*),count(*) filter(where principal_type='service' and principal_id=$3 and payload=$4::jsonb)
			from verrail_audit_events where workspace_id=$1 and aggregate_id=$2 and aggregate_type='artifact_revision' and event_type='assurance.artifact_revision_added.v1'`,
			proof.Identity.WorkspaceID, revision.id, fixedCIRepositoryExecutor, expected).Scan(&count, &matching); err != nil {
			return err
		}
		if count != 1 || matching != 1 {
			return fixedCIProofMismatch()
		}
	}
	return nil
}
