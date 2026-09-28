package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/verrail/verrail/services/domain-api/internal/target"
)

func TestOutboxRecoveryAuthenticatesAndBindsCommand(t *testing.T) {
	for _, test := range []struct {
		principal, token string
		status           int
	}{
		{"user", "Bearer domain-token", http.StatusOK},
		{"service", "Bearer domain-token", http.StatusForbidden},
		{"user", "", http.StatusUnauthorized},
	} {
		called := false
		server := &Server{token: "domain-token", retryRunOutbox: func(_ *http.Request, command target.RetryRunOutboxCommand) (target.RetryRunOutboxResult, error) {
			called = true
			require.Equal(t, candidateTestWorkspaceID, command.WorkspaceID)
			require.Equal(t, "operator", command.Principal.ID)
			require.Equal(t, 3, command.Input.ExpectedAttemptCount)
			require.NotEmpty(t, command.RequestHash)
			return target.RetryRunOutboxResult{SchemaVersion: 1, EventID: command.Input.EventID, Status: "pending"}, nil
		}}
		request := candidateRequest("/outbox/retry", `{"eventId":"33333333-3333-4333-8333-333333333333","expectedAttemptCount":3}`, test.principal, "operator")
		request.SetPathValue("runId", "22222222-2222-4222-8222-222222222222")
		request.Header.Set("Authorization", test.token)
		response := httptest.NewRecorder()
		server.retryOutbox(response, request)
		require.Equal(t, test.status, response.Code)
		require.Equal(t, test.status == http.StatusOK, called)
	}
}
