package httpapi

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
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

func TestDeliveryProofHTTPDoesNotTrustDomainBearer(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	configuration, err := ConfigureDeliveryProof("", nil)
	require.NoError(t, err)
	require.Nil(t, configuration)
	public, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	ci, err := target.ParseFixedCIProofTrustProfile(fixedCIHTTPProfile(t))
	require.NoError(t, err)
	profile := target.DeliveryProofTrustProfile{SchemaVersion: 1, CI: ci, PublicKey: base64.StdEncoding.EncodeToString(public),
		ReaderPolicySHA256: strings.Repeat("1", 64), VerifierBuildSHA256: strings.Repeat("2", 64), RuntimeManifestSHA256: strings.Repeat("3", 64), MaxAgeMS: 300000}
	raw, err := json.Marshal(profile)
	require.NoError(t, err)
	configuration, err = ConfigureDeliveryProof(string(raw), target.NewStore(nil))
	require.NoError(t, err)
	for _, config := range []*DeliveryProofConfiguration{nil, configuration} {
		handler := NewWithProofVerifiers("domain-token", nil, logger, nil, config)
		r := httptest.NewRequest(http.MethodPost, "/v1/workspaces/"+candidateTestWorkspaceID+"/delivery-proofs", strings.NewReader(`{"schemaVersion":1,"payload":"e30=","signature":"`+base64.StdEncoding.EncodeToString(make([]byte, 64))+`"}`))
		r.Header.Set("Authorization", "Bearer domain-token")
		r.Header.Set("Idempotency-Key", "delivery-http-key")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.GreaterOrEqual(t, w.Code, 400)
		require.NotContains(t, w.Body.String(), "domain-token")
	}
}
