package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/verrail/verrail/services/domain-api/internal/target"
)

const candidateTestWorkspaceID = "11111111-1111-4111-8111-111111111111"

func candidateRequest(path, body, principalType, principalID string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	request.SetPathValue("workspaceId", candidateTestWorkspaceID)
	request.Header.Set("Authorization", "Bearer domain-token")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "candidate-http-test")
	request.Header.Set("X-Verrail-Principal-Type", principalType)
	request.Header.Set("X-Verrail-Principal-Id", principalID)
	return request
}

func TestCandidateHandlersBindPrincipalFromAuthenticatedHeaders(t *testing.T) {
	t.Run("service may create a submission", func(t *testing.T) {
		var captured target.Principal
		server := &Server{
			token: "domain-token",
			createSubmission: func(_ *http.Request, command target.AgentLifecycleCommand[target.CreateSubmissionInput]) (target.AgentLifecycleResult, error) {
				captured = command.Principal
				return target.AgentLifecycleResult{SchemaVersion: 1, ResourceType: "submission", ResourceID: "22222222-2222-4222-8222-222222222222"}, nil
			},
		}
		request := candidateRequest("/v1/workspaces/"+candidateTestWorkspaceID+"/submissions", `{"targetId":"22222222-2222-4222-8222-222222222222","targetRevisionId":"33333333-3333-4333-8333-333333333333","artifactRevisionIds":["44444444-4444-4444-8444-444444444444"],"verificationResultIds":[]}`, "service", "graph-orchestrator")
		response := httptest.NewRecorder()

		server.createAdjudicationSubmission(response, request)

		require.Equal(t, http.StatusCreated, response.Code)
		require.Equal(t, target.Principal{Type: "service", ID: "graph-orchestrator"}, captured)
	})

	t.Run("agent may request a pull request action", func(t *testing.T) {
		var captured target.Principal
		server := &Server{
			token: "domain-token",
			requestPullRequestAction: func(_ *http.Request, command target.AgentLifecycleCommand[target.RequestPullRequestActionInput]) (target.AgentLifecycleResult, error) {
				captured = command.Principal
				return target.AgentLifecycleResult{SchemaVersion: 1, ResourceType: "action_request", ResourceID: "55555555-5555-4555-8555-555555555555"}, nil
			},
		}
		request := candidateRequest("/v1/workspaces/"+candidateTestWorkspaceID+"/pull-request-actions", `{"targetId":"22222222-2222-4222-8222-222222222222","submissionId":"33333333-3333-4333-8333-333333333333","params":{"title":"Ship","head":"feat/ship","base":"main"}}`, "agent", "agent-1")
		response := httptest.NewRecorder()

		server.requestConnectorPullRequestAction(response, request)

		require.Equal(t, http.StatusCreated, response.Code)
		require.Equal(t, target.Principal{Type: "agent", ID: "agent-1"}, captured)
	})

	t.Run("service may record an integration result", func(t *testing.T) {
		var captured target.Principal
		server := &Server{
			token: "domain-token",
			recordIntegrationRun: func(_ *http.Request, command target.AgentLifecycleCommand[target.RecordIntegrationRunInput]) (target.AgentLifecycleResult, error) {
				captured = command.Principal
				return target.AgentLifecycleResult{SchemaVersion: 1, ResourceType: "integration_run", ResourceID: "77777777-7777-4777-8777-777777777777"}, nil
			},
		}
		request := candidateRequest("/v1/workspaces/"+candidateTestWorkspaceID+"/integration-runs", `{"targetId":"22222222-2222-4222-8222-222222222222","targetRevisionId":"33333333-3333-4333-8333-333333333333","graphRevisionId":"44444444-4444-4444-8444-444444444444","claimId":"55555555-5555-4555-8555-555555555555","workNodeId":"66666666-6666-4666-8666-666666666666","connectorVersion":"github.v1","connectionId":"77777777-7777-4777-8777-777777777777","provider":"github","externalRef":"run/1","commitRef":"abc123","criterionKey":"criterion-1","environmentRef":"github:owner/repo:main","conclusion":"success","objectHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reference":"ci:run:1","providerReceipt":{"runId":1}}`, "service", "github-connector")
		response := httptest.NewRecorder()

		server.recordConnectorIntegrationRun(response, request)

		require.Equal(t, http.StatusCreated, response.Code)
		require.Equal(t, target.Principal{Type: "service", ID: "github-connector"}, captured)
	})
}

func TestHumanGovernanceHandlersRejectNonHumanPrincipals(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		handle func(*Server, http.ResponseWriter, *http.Request)
	}{
		{
			name: "review",
			body: `{"submissionId":"22222222-2222-4222-8222-222222222222","reviewerPrincipalType":"user","reviewerPrincipalId":"agent-1","verdict":"approved","unprovenItems":[]}`,
			handle: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.recordAdjudicationDeliveryReview(response, request)
			},
		},
		{
			name: "acceptance",
			body: `{"submissionId":"22222222-2222-4222-8222-222222222222","reviewId":"33333333-3333-4333-8333-333333333333"}`,
			handle: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.acceptAdjudicationSubmission(response, request)
			},
		},
		{
			name: "approval",
			body: `{"actionRequestId":"22222222-2222-4222-8222-222222222222","approverPrincipalType":"user","approverPrincipalId":"agent-1","paramsHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`,
			handle: func(server *Server, response http.ResponseWriter, request *http.Request) {
				request.SetPathValue("actionRequestId", "22222222-2222-4222-8222-222222222222")
				server.approveConnectorAction(response, request)
			},
		},
		{
			name: "human work result",
			body: `{"targetId":"22222222-2222-4222-8222-222222222222","targetRevisionId":"33333333-3333-4333-8333-333333333333","graphRevisionId":"44444444-4444-4444-8444-444444444444","workNodeId":"55555555-5555-4555-8555-555555555555","inputHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","result":{"decision":"ready"},"attachmentHashes":[]}`,
			handle: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.recordConnectorHumanWorkResult(response, request)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := &Server{token: "domain-token"}
			request := candidateRequest("/", test.body, "agent", "agent-1")
			response := httptest.NewRecorder()

			test.handle(server, response, request)

			require.Equal(t, http.StatusForbidden, response.Code)
			require.Contains(t, response.Body.String(), "AGENT_LIFECYCLE_FORBIDDEN")
		})
	}
}

func TestCandidateHandlersRejectBodyPrincipalSpoofing(t *testing.T) {
	server := &Server{
		token: "domain-token",
		createSubmission: func(_ *http.Request, _ target.AgentLifecycleCommand[target.CreateSubmissionInput]) (target.AgentLifecycleResult, error) {
			t.Fatal("spoofed command must not reach the store")
			return target.AgentLifecycleResult{}, nil
		},
	}
	request := candidateRequest("/", `{"targetId":"22222222-2222-4222-8222-222222222222","targetRevisionId":"33333333-3333-4333-8333-333333333333","artifactRevisionIds":["44444444-4444-4444-8444-444444444444"],"verificationResultIds":[],"principalType":"service","principalId":"spoofed"}`, "user", "human-1")
	response := httptest.NewRecorder()

	server.createAdjudicationSubmission(response, request)

	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Contains(t, response.Body.String(), "TARGET_COMMAND_INVALID")
}
