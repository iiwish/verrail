package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/verrail/verrail/services/domain-api/internal/target"
)

const maxBodyBytes = 64 * 1024

type createFunc func(*http.Request, target.CreateCommand) (target.CreateResult, error)
type createGraphRevisionFunc func(*http.Request, target.CreateGraphRevisionCommand) (target.CreateGraphRevisionResult, error)
type activateGraphRevisionFunc func(*http.Request, target.ActivateGraphRevisionCommand) (target.ActivateGraphRevisionResult, error)
type createRunFunc func(*http.Request, target.CreateRunCommand) (target.CreateRunResult, error)
type createRunAttemptFunc func(*http.Request, target.CreateRunAttemptCommand) (target.CreateRunAttemptResult, error)
type reportRunEventFunc func(*http.Request, target.ReportRunEventCommand) (target.ReportRunEventResult, error)
type requestRunCancellationFunc func(*http.Request, target.RequestRunCancellationCommand) (target.RequestRunCancellationResult, error)
type createAgentDefinitionFunc func(*http.Request, target.AgentLifecycleCommand[target.AgentDefinitionInput]) (target.AgentLifecycleResult, error)
type updateAgentDefinitionFunc func(*http.Request, target.AgentLifecycleCommand[target.UpdateAgentDefinitionInput]) (target.AgentLifecycleResult, error)
type publishAgentVersionFunc func(*http.Request, target.AgentLifecycleCommand[target.PublishAgentVersionInput]) (target.AgentLifecycleResult, error)
type recordEvaluationRunFunc func(*http.Request, target.AgentLifecycleCommand[target.EvaluationRunInput]) (target.AgentLifecycleResult, error)
type createDeploymentFunc func(*http.Request, target.AgentLifecycleCommand[target.CreateDeploymentInput]) (target.AgentLifecycleResult, error)
type reviseDeploymentFunc func(*http.Request, target.AgentLifecycleCommand[target.ReviseDeploymentInput]) (target.AgentLifecycleResult, error)
type createArtifactFunc func(*http.Request, target.AgentLifecycleCommand[target.CreateArtifactInput]) (target.AgentLifecycleResult, error)
type addArtifactRevisionFunc func(*http.Request, target.AgentLifecycleCommand[target.AddArtifactRevisionInput]) (target.AgentLifecycleResult, error)
type createClaimFunc func(*http.Request, target.AgentLifecycleCommand[target.CreateClaimInput]) (target.AgentLifecycleResult, error)
type recordEvidenceFunc func(*http.Request, target.AgentLifecycleCommand[target.RecordEvidenceInput]) (target.AgentLifecycleResult, error)
type recordVerificationResultFunc func(*http.Request, target.AgentLifecycleCommand[target.RecordVerificationResultInput]) (target.AgentLifecycleResult, error)
type createSubmissionFunc func(*http.Request, target.AgentLifecycleCommand[target.CreateSubmissionInput]) (target.AgentLifecycleResult, error)
type recordDeliveryReviewFunc func(*http.Request, target.AgentLifecycleCommand[target.RecordDeliveryReviewInput]) (target.AgentLifecycleResult, error)
type acceptSubmissionFunc func(*http.Request, target.AgentLifecycleCommand[target.AcceptSubmissionInput]) (target.AgentLifecycleResult, error)
type recordIntegrationRunFunc func(*http.Request, target.AgentLifecycleCommand[target.RecordIntegrationRunInput]) (target.AgentLifecycleResult, error)
type requestPullRequestActionFunc func(*http.Request, target.AgentLifecycleCommand[target.RequestPullRequestActionInput]) (target.AgentLifecycleResult, error)
type approveActionFunc func(*http.Request, target.AgentLifecycleCommand[target.ApproveActionInput]) (target.AgentLifecycleResult, error)
type executeActionFunc func(*http.Request, target.AgentLifecycleCommand[target.ExecuteActionInput]) (target.AgentLifecycleResult, error)
type createGithubRepoBindingFunc func(*http.Request, target.AgentLifecycleCommand[target.CreateGithubRepoBindingInput]) (target.AgentLifecycleResult, error)

type Server struct {
	token                    string
	create                   createFunc
	createGraphRevision      createGraphRevisionFunc
	activateGraphRevision    activateGraphRevisionFunc
	createRun                createRunFunc
	createRunAttempt         createRunAttemptFunc
	reportRunEvent           reportRunEventFunc
	requestRunCancellation   requestRunCancellationFunc
	createAgentDefinition    createAgentDefinitionFunc
	updateAgentDefinition    updateAgentDefinitionFunc
	publishAgentVersion      publishAgentVersionFunc
	recordEvaluationRun      recordEvaluationRunFunc
	createDeployment         createDeploymentFunc
	reviseDeployment         reviseDeploymentFunc
	createArtifact           createArtifactFunc
	addArtifactRevision      addArtifactRevisionFunc
	createClaim              createClaimFunc
	recordEvidence           recordEvidenceFunc
	recordVerificationResult recordVerificationResultFunc
	createSubmission         createSubmissionFunc
	recordDeliveryReview     recordDeliveryReviewFunc
	acceptSubmission         acceptSubmissionFunc
	recordIntegrationRun     recordIntegrationRunFunc
	requestPullRequestAction requestPullRequestActionFunc
	approveAction            approveActionFunc
	executeAction            executeActionFunc
	createGithubRepoBinding  createGithubRepoBindingFunc
	logger                   *slog.Logger
}

func New(token string, store *target.Store, logger *slog.Logger) http.Handler {
	server := &Server{
		token:  token,
		logger: logger,
		create: func(request *http.Request, command target.CreateCommand) (target.CreateResult, error) {
			return store.Create(request.Context(), command)
		},
		createGraphRevision: func(request *http.Request, command target.CreateGraphRevisionCommand) (target.CreateGraphRevisionResult, error) {
			return store.CreateGraphRevision(request.Context(), command)
		},
		activateGraphRevision: func(request *http.Request, command target.ActivateGraphRevisionCommand) (target.ActivateGraphRevisionResult, error) {
			return store.ActivateGraphRevision(request.Context(), command)
		},
		createRun: func(request *http.Request, command target.CreateRunCommand) (target.CreateRunResult, error) {
			return store.CreateRun(request.Context(), command)
		},
		createRunAttempt: func(request *http.Request, command target.CreateRunAttemptCommand) (target.CreateRunAttemptResult, error) {
			return store.CreateRunAttempt(request.Context(), command)
		},
		reportRunEvent: func(request *http.Request, command target.ReportRunEventCommand) (target.ReportRunEventResult, error) {
			return store.ReportRunEvent(request.Context(), command)
		},
		requestRunCancellation: func(request *http.Request, command target.RequestRunCancellationCommand) (target.RequestRunCancellationResult, error) {
			return store.RequestRunCancellation(request.Context(), command)
		},
		createAgentDefinition: func(request *http.Request, command target.AgentLifecycleCommand[target.AgentDefinitionInput]) (target.AgentLifecycleResult, error) {
			return store.CreateAgentDefinition(request.Context(), command)
		},
		updateAgentDefinition: func(request *http.Request, command target.AgentLifecycleCommand[target.UpdateAgentDefinitionInput]) (target.AgentLifecycleResult, error) {
			return store.UpdateAgentDefinition(request.Context(), command)
		},
		publishAgentVersion: func(request *http.Request, command target.AgentLifecycleCommand[target.PublishAgentVersionInput]) (target.AgentLifecycleResult, error) {
			return store.PublishAgentVersion(request.Context(), command)
		},
		recordEvaluationRun: func(request *http.Request, command target.AgentLifecycleCommand[target.EvaluationRunInput]) (target.AgentLifecycleResult, error) {
			return store.RecordEvaluationRun(request.Context(), command)
		},
		createDeployment: func(request *http.Request, command target.AgentLifecycleCommand[target.CreateDeploymentInput]) (target.AgentLifecycleResult, error) {
			return store.CreateDeployment(request.Context(), command)
		},
		reviseDeployment: func(request *http.Request, command target.AgentLifecycleCommand[target.ReviseDeploymentInput]) (target.AgentLifecycleResult, error) {
			return store.ReviseDeployment(request.Context(), command)
		},
		createArtifact: func(request *http.Request, command target.AgentLifecycleCommand[target.CreateArtifactInput]) (target.AgentLifecycleResult, error) {
			return store.CreateArtifact(request.Context(), command)
		},
		addArtifactRevision: func(request *http.Request, command target.AgentLifecycleCommand[target.AddArtifactRevisionInput]) (target.AgentLifecycleResult, error) {
			return store.AddArtifactRevision(request.Context(), command)
		},
		createClaim: func(request *http.Request, command target.AgentLifecycleCommand[target.CreateClaimInput]) (target.AgentLifecycleResult, error) {
			return store.CreateClaim(request.Context(), command)
		},
		recordEvidence: func(request *http.Request, command target.AgentLifecycleCommand[target.RecordEvidenceInput]) (target.AgentLifecycleResult, error) {
			return store.RecordEvidence(request.Context(), command)
		},
		recordVerificationResult: func(request *http.Request, command target.AgentLifecycleCommand[target.RecordVerificationResultInput]) (target.AgentLifecycleResult, error) {
			return store.RecordVerificationResult(request.Context(), command)
		},
		createSubmission: func(request *http.Request, command target.AgentLifecycleCommand[target.CreateSubmissionInput]) (target.AgentLifecycleResult, error) {
			return store.CreateSubmission(request.Context(), command)
		},
		recordDeliveryReview: func(request *http.Request, command target.AgentLifecycleCommand[target.RecordDeliveryReviewInput]) (target.AgentLifecycleResult, error) {
			return store.RecordDeliveryReview(request.Context(), command)
		},
		acceptSubmission: func(request *http.Request, command target.AgentLifecycleCommand[target.AcceptSubmissionInput]) (target.AgentLifecycleResult, error) {
			return store.AcceptSubmission(request.Context(), command)
		},
		recordIntegrationRun: func(request *http.Request, command target.AgentLifecycleCommand[target.RecordIntegrationRunInput]) (target.AgentLifecycleResult, error) {
			return store.RecordIntegrationRun(request.Context(), command)
		},
		requestPullRequestAction: func(request *http.Request, command target.AgentLifecycleCommand[target.RequestPullRequestActionInput]) (target.AgentLifecycleResult, error) {
			return store.RequestPullRequestAction(request.Context(), command)
		},
		approveAction: func(request *http.Request, command target.AgentLifecycleCommand[target.ApproveActionInput]) (target.AgentLifecycleResult, error) {
			return store.ApproveAction(request.Context(), command)
		},
		executeAction: func(request *http.Request, command target.AgentLifecycleCommand[target.ExecuteActionInput]) (target.AgentLifecycleResult, error) {
			return store.ExecuteAction(request.Context(), command)
		},
		createGithubRepoBinding: func(request *http.Request, command target.AgentLifecycleCommand[target.CreateGithubRepoBindingInput]) (target.AgentLifecycleResult, error) {
			return store.CreateGithubRepoBinding(request.Context(), command)
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", server.health)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/targets", server.createTarget)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/targets/{targetId}/graph-revisions", server.createGraph)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/targets/{targetId}/graph-revisions/{graphRevisionId}/activate", server.activateGraph)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/targets/{targetId}/graph-revisions/{graphRevisionId}/nodes/{workNodeId}/runs", server.createNativeRun)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/runs/{runId}/attempts", server.createAttempt)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/runs/{runId}/attempts/{runAttemptId}/events", server.reportAttemptEvent)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/runs/{runId}/cancel", server.cancelRun)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/agent-definitions", server.createDefinition)
	mux.HandleFunc("PATCH /v1/workspaces/{workspaceId}/agent-definitions/{definitionId}", server.updateDefinition)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/agent-definitions/{definitionId}/versions", server.publishVersion)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/evaluation-runs", server.recordEvaluation)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/deployments", server.createAgentDeployment)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/deployments/{deploymentId}/revisions", server.reviseAgentDeployment)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/artifacts", server.createAssuranceArtifact)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/artifact-revisions", server.addAssuranceArtifactRevision)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/claims", server.createAssuranceClaim)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/evidence", server.recordAssuranceEvidence)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/verification-results", server.recordAssuranceVerificationResult)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/submissions", server.createAdjudicationSubmission)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/delivery-reviews", server.recordAdjudicationDeliveryReview)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/acceptances", server.acceptAdjudicationSubmission)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/integration-runs", server.recordConnectorIntegrationRun)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/pull-request-actions", server.requestConnectorPullRequestAction)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/pull-request-actions/{actionRequestId}/approvals", server.approveConnectorAction)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/pull-request-actions/{actionRequestId}/executions", server.executeConnectorAction)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/github-repo-bindings", server.createConnectorGithubRepoBinding)
	return mux
}

func (server *Server) lifecycleAuthorized(response http.ResponseWriter, request *http.Request) bool {
	if server.authorized(request) {
		return true
	}
	writeError(response, &target.Error{Status: 401, Code: "DOMAIN_API_UNAUTHORIZED", Message: "Unauthorized"})
	return false
}

func lifecycleStatus(result target.AgentLifecycleResult) int {
	if result.Replayed {
		return http.StatusOK
	}
	return http.StatusCreated
}

func (server *Server) createDefinition(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.AgentDefinitionInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: "agent_definition.create.v1"}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateDefinitionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createAgentDefinition(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) updateDefinition(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.UpdateAgentDefinitionInput]{WorkspaceID: request.PathValue("workspaceId"), ResourceID: request.PathValue("definitionId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: "agent_definition.update.v1"}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateUpdateDefinitionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.updateAgentDefinition(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) publishVersion(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.PublishAgentVersionInput]{WorkspaceID: request.PathValue("workspaceId"), ResourceID: request.PathValue("definitionId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: "agent_version.publish.v1"}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidatePublishInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.publishAgentVersion(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) recordEvaluation(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.EvaluationRunInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: "evaluation_run.record.v1"}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateEvaluationInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.recordEvaluationRun(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) createAgentDeployment(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.CreateDeploymentInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: "deployment.create.v1"}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateDeploymentInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createDeployment(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) reviseAgentDeployment(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.ReviseDeploymentInput]{WorkspaceID: request.PathValue("workspaceId"), ResourceID: request.PathValue("deploymentId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: "deployment.revise.v1"}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateReviseDeploymentInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.reviseDeployment(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) createAssuranceArtifact(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.CreateArtifactInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AssuranceArtifactCreateCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateArtifactInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createArtifact(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) addAssuranceArtifactRevision(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.AddArtifactRevisionInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AssuranceArtifactRevisionAddCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateAddArtifactRevisionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.addArtifactRevision(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) createAssuranceClaim(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.CreateClaimInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AssuranceClaimCreateCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateClaimInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createClaim(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) recordAssuranceEvidence(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.RecordEvidenceInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AssuranceEvidenceRecordCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateRecordEvidenceInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.recordEvidence(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) recordAssuranceVerificationResult(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.RecordVerificationResultInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AssuranceVerificationRecordCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateRecordVerificationResultInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.recordVerificationResult(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) createAdjudicationSubmission(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.CreateSubmissionInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AdjudicationSubmissionCreateCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateSubmissionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createSubmission(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) recordAdjudicationDeliveryReview(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.RecordDeliveryReviewInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AdjudicationReviewRecordCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateRecordDeliveryReviewInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.recordDeliveryReview(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) acceptAdjudicationSubmission(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.AcceptSubmissionInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.AdjudicationAcceptanceCreateCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateAcceptSubmissionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.acceptSubmission(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) recordConnectorIntegrationRun(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.RecordIntegrationRunInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.ConnectorIntegrationRunRecordCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateRecordIntegrationRunInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.recordIntegrationRun(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) requestConnectorPullRequestAction(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.RequestPullRequestActionInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.ConnectorActionRequestCreateCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateRequestPullRequestActionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.requestPullRequestAction(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) approveConnectorAction(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.ApproveActionInput]{WorkspaceID: request.PathValue("workspaceId"), ResourceID: request.PathValue("actionRequestId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.ConnectorActionApproveCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateApproveActionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.approveAction(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) executeConnectorAction(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.ExecuteActionInput]{WorkspaceID: request.PathValue("workspaceId"), ResourceID: request.PathValue("actionRequestId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.ConnectorActionExecuteCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateExecuteActionInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.executeAction(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func (server *Server) createConnectorGithubRepoBinding(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.AgentLifecycleCommand[target.CreateGithubRepoBindingInput]{WorkspaceID: request.PathValue("workspaceId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key"), CommandType: target.ConnectorRepoBindingCreateCommand}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateGithubRepoBindingInput(&command.Input); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	if err := target.ValidateAgentLifecycleCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createGithubRepoBinding(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}

func principal(request *http.Request) target.Principal {
	return target.Principal{Type: request.Header.Get("X-Verrail-Principal-Type"), ID: request.Header.Get("X-Verrail-Principal-Id")}
}

func decodeBody(response http.ResponseWriter, request *http.Request, output any) *target.Error {
	request.Body = http.MaxBytesReader(response, request.Body, maxBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Invalid command"}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Command must contain one JSON object"}
	}
	return nil
}

func (server *Server) createGraph(response http.ResponseWriter, request *http.Request) {
	if !server.authorized(request) {
		writeError(response, &target.Error{Status: 401, Code: "DOMAIN_API_UNAUTHORIZED", Message: "Unauthorized"})
		return
	}
	command := target.CreateGraphRevisionCommand{WorkspaceID: request.PathValue("workspaceId"), TargetID: request.PathValue("targetId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key")}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateGraphRevisionCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createGraphRevision(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeJSON(response, status, result)
}

func (server *Server) activateGraph(response http.ResponseWriter, request *http.Request) {
	if !server.authorized(request) {
		writeError(response, &target.Error{Status: 401, Code: "DOMAIN_API_UNAUTHORIZED", Message: "Unauthorized"})
		return
	}
	command := target.ActivateGraphRevisionCommand{WorkspaceID: request.PathValue("workspaceId"), TargetID: request.PathValue("targetId"), GraphRevisionID: request.PathValue("graphRevisionId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key")}
	if err := target.ValidateActivationCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.activateGraphRevision(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (server *Server) createNativeRun(response http.ResponseWriter, request *http.Request) {
	if !server.authorized(request) {
		writeError(response, &target.Error{Status: 401, Code: "DOMAIN_API_UNAUTHORIZED", Message: "Unauthorized"})
		return
	}
	command := target.CreateRunCommand{WorkspaceID: request.PathValue("workspaceId"), TargetID: request.PathValue("targetId"), GraphRevisionID: request.PathValue("graphRevisionId"), WorkNodeID: request.PathValue("workNodeId"), Principal: principal(request), IdempotencyKey: request.Header.Get("Idempotency-Key")}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateRunCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createRun(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeJSON(response, status, result)
}

func (server *Server) createAttempt(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.CreateRunAttemptCommand{
		WorkspaceID:    request.PathValue("workspaceId"),
		RunID:          request.PathValue("runId"),
		Principal:      principal(request),
		IdempotencyKey: request.Header.Get("Idempotency-Key"),
	}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateCreateRunAttemptCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.createRunAttempt(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeJSON(response, status, result)
}

func (server *Server) reportAttemptEvent(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.ReportRunEventCommand{
		WorkspaceID:    request.PathValue("workspaceId"),
		RunID:          request.PathValue("runId"),
		RunAttemptID:   request.PathValue("runAttemptId"),
		Principal:      principal(request),
		IdempotencyKey: request.Header.Get("Idempotency-Key"),
	}
	if err := decodeBody(response, request, &command.Input); err != nil {
		writeError(response, err)
		return
	}
	if err := target.ValidateReportRunEventCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.reportRunEvent(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	} else if !result.Authoritative {
		status = http.StatusAccepted
	}
	writeJSON(response, status, result)
}

func (server *Server) cancelRun(response http.ResponseWriter, request *http.Request) {
	if !server.lifecycleAuthorized(response, request) {
		return
	}
	command := target.RequestRunCancellationCommand{
		WorkspaceID:    request.PathValue("workspaceId"),
		RunID:          request.PathValue("runId"),
		Principal:      principal(request),
		IdempotencyKey: request.Header.Get("Idempotency-Key"),
	}
	if err := target.ValidateRequestRunCancellationCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.requestRunCancellation(request, command)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (server *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{"status": "ok", "service": "verrail-domain-api"})
}

func (server *Server) createTarget(response http.ResponseWriter, request *http.Request) {
	if !server.authorized(request) {
		writeError(response, &target.Error{Status: 401, Code: "DOMAIN_API_UNAUTHORIZED", Message: "Unauthorized"})
		return
	}
	command := target.CreateCommand{
		WorkspaceID: request.PathValue("workspaceId"),
		Principal: target.Principal{
			Type: request.Header.Get("X-Verrail-Principal-Type"),
			ID:   request.Header.Get("X-Verrail-Principal-Id"),
		},
		IdempotencyKey: request.Header.Get("Idempotency-Key"),
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command.Input); err != nil {
		status := 400
		code := "TARGET_COMMAND_INVALID"
		if strings.Contains(err.Error(), "request body too large") {
			status, code = 413, "TARGET_COMMAND_TOO_LARGE"
		}
		writeError(response, &target.Error{Status: status, Code: code, Message: "Invalid Target command"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(response, &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Target command must contain one JSON object"})
		return
	}
	if err := target.ValidateCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.create(request, command)
	if err != nil {
		domainError := target.AsError(err)
		if domainError.Status >= 500 {
			server.logger.Error("Target command failed", "error", err)
		}
		writeError(response, domainError)
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeJSON(response, status, result)
}

func (server *Server) authorized(request *http.Request) bool {
	provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	if server.token == "" || len(provided) != len(server.token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(server.token)) == 1
}

func writeError(response http.ResponseWriter, err *target.Error) {
	writeJSON(response, err.Status, map[string]any{
		"error":     err.Message,
		"code":      err.Code,
		"retryable": err.Retryable,
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
