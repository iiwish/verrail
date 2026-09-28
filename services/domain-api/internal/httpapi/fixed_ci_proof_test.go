package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/verrail/verrail/services/domain-api/internal/target"
)

func TestFixedCIProofRouteRequiresSeparateStartupCapability(t *testing.T) {
	handler := New("domain-token", nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, authorization := range []string{"", "Bearer domain-token", "Bearer unconfigured-proof-token"} {
		request := httptest.NewRequest(http.MethodPost, "/v1/workspaces/"+candidateTestWorkspaceID+"/github-fixed-ci-proofs", strings.NewReader(`{}`))
		request.Header.Set("Authorization", authorization)
		request.Header.Set("X-Verrail-Principal-Type", "service")
		request.Header.Set("X-Verrail-Principal-Id", "github-fixed-ci-verifier.v1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusUnauthorized, response.Code)
		require.Contains(t, response.Body.String(), "FIXED_CI_PROOF_UNAUTHORIZED")
	}
}

func fixedCIHTTPProfile(t *testing.T) string {
	t.Helper()
	profile := target.FixedCIProofTrustProfile{SchemaVersion: 1, WorkspaceID: candidateTestWorkspaceID, TargetID: "22222222-2222-4222-8222-222222222222", TargetRevisionID: "33333333-3333-4333-8333-333333333333", GraphRevisionID: "44444444-4444-4444-8444-444444444444", ConnectionID: "55555555-5555-4555-8555-555555555555", BindingID: "66666666-6666-4666-8666-666666666666", Repository: "owner/repo", RepositoryID: 1, WorkflowID: 2, WorkflowExecutionSHA: strings.Repeat("a", 40), PolicySHA256: strings.Repeat("b", 64), WorkflowSHA256: strings.Repeat("c", 64), HelperSHA256: strings.Repeat("d", 64), MaxAgeMS: 86400000}
	raw, err := json.Marshal(profile)
	require.NoError(t, err)
	return string(raw)
}

func TestFixedCIProofStartupConfiguration(t *testing.T) {
	domainToken, proofToken := strings.Repeat("d", 32), strings.Repeat("p", 32)
	config, err := ConfigureFixedCIProof(domainToken, "", "", nil)
	require.NoError(t, err)
	require.Nil(t, config)
	profile := fixedCIHTTPProfile(t)
	config, err = ConfigureFixedCIProof(domainToken, proofToken, profile, nil)
	require.NoError(t, err)
	require.NotNil(t, config)
	for _, test := range []struct{ token, profile string }{{"", profile}, {proofToken, ""}, {domainToken, profile}, {"short", profile}, {proofToken + "\n", profile}, {proofToken, "SYNTHETIC_PRIVATE_CONFIG_SENTINEL"}, {proofToken, strings.Replace(profile, `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1)}} {
		_, err := ConfigureFixedCIProof(domainToken, test.token, test.profile, nil)
		require.EqualError(t, err, "FIXED_CI_PROOF_CONFIG_INVALID")
	}
}

func TestFixedCIProofTokenAndIdentityIsolation(t *testing.T) {
	proofToken := strings.Repeat("p", 32)
	calls := 0
	configuration := &FixedCIProofConfiguration{token: proofToken, record: func(_ *http.Request, workspaceID, key string, input target.FixedCIProofInput) (target.AgentLifecycleResult, error) {
		calls++
		require.Equal(t, candidateTestWorkspaceID, workspaceID)
		require.Equal(t, "fixed-proof-http", key)
		return target.AgentLifecycleResult{SchemaVersion: 1, ResourceType: "integration_run", ResourceID: "22222222-2222-4222-8222-222222222222"}, nil
	}}
	handler := NewWithFixedCIProof("domain-token", nil, slog.New(slog.NewTextHandler(io.Discard, nil)), configuration)
	request := func(path, authorization, body, principal string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/workspaces/"+candidateTestWorkspaceID+path, strings.NewReader(body))
		r.Header.Set("Authorization", authorization)
		r.Header.Set("Idempotency-Key", "fixed-proof-http")
		r.Header.Set("X-Verrail-Principal-Id", principal)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	wire, err := json.Marshal(target.FixedCIProofInput{})
	require.NoError(t, err)
	body := string(wire)
	require.Equal(t, http.StatusUnauthorized, request("/github-fixed-ci-proofs", "Bearer domain-token", body, "").Code)
	require.Equal(t, http.StatusUnauthorized, request("/github-fixed-ci-proofs", proofToken, body, "").Code)
	require.Equal(t, http.StatusUnauthorized, request("/integration-runs", "Bearer "+proofToken, body, "").Code)
	require.Equal(t, http.StatusBadRequest, request("/github-fixed-ci-proofs", "Bearer "+proofToken, body, "github-fixed-ci-verifier").Code)
	for _, invalid := range []string{`{"source":{"artifactOrdinal":0},"assertions":["go_tests"]}`, `{"source":{"artifactOrdinal":0},"principal":{}}`, `{"source":{"artifactOrdinal":0},"conclusion":"success"}`, `{"source":{"artifactOrdinal":0,"artifactOrdinal":0}}`, `{"source":{}}`, `{"source":{"artifactOrdinal":null}}`} {
		require.Equal(t, http.StatusBadRequest, request("/github-fixed-ci-proofs", "Bearer "+proofToken, invalid, "").Code)
	}
	require.Zero(t, calls)
	require.Equal(t, http.StatusCreated, request("/github-fixed-ci-proofs", "Bearer "+proofToken, body, "").Code)
	require.Equal(t, 1, calls)
}
