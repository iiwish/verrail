package httpapi

import (
	"crypto/subtle"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/verrail/verrail/services/domain-api/internal/target"
)

type FixedCIProofConfiguration struct {
	token  string
	record func(*http.Request, string, string, target.FixedCIProofInput) (target.AgentLifecycleResult, error)
}

func ConfigureFixedCIProof(domainToken, proofToken, profileJSON string, store *target.Store) (*FixedCIProofConfiguration, error) {
	if proofToken == "" && profileJSON == "" {
		return nil, nil
	}
	invalid := errors.New("FIXED_CI_PROOF_CONFIG_INVALID")
	if domainToken == "" || len(proofToken) < 32 || len(proofToken) > 4096 || proofToken == strings.TrimSpace(domainToken) {
		return nil, invalid
	}
	for _, character := range proofToken {
		if character < 33 || character > 126 {
			return nil, invalid
		}
	}
	profile, err := target.ParseFixedCIProofTrustProfile(profileJSON)
	if err != nil {
		return nil, invalid
	}
	verifier, err := target.NewFixedCIProofVerifier(store, profile)
	if err != nil {
		return nil, invalid
	}
	return &FixedCIProofConfiguration{token: proofToken, record: func(request *http.Request, workspaceID, key string, input target.FixedCIProofInput) (target.AgentLifecycleResult, error) {
		return verifier.Record(request.Context(), workspaceID, key, input)
	}}, nil
}

func NewWithFixedCIProof(token string, store *target.Store, logger *slog.Logger, configuration *FixedCIProofConfiguration) http.Handler {
	return newServer(token, store, logger, configuration)
}

func (server *Server) recordFixedCIProof(response http.ResponseWriter, request *http.Request) {
	provided, bearer := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
	configuration := server.fixedCIProof
	if configuration == nil || !bearer || len(provided) != len(configuration.token) || subtle.ConstantTimeCompare([]byte(provided), []byte(configuration.token)) != 1 {
		writeError(response, &target.Error{Status: 401, Code: "FIXED_CI_PROOF_UNAUTHORIZED", Message: "Unauthorized"})
		return
	}
	if request.Header.Get("X-Verrail-Principal-Type") != "" || request.Header.Get("X-Verrail-Principal-Id") != "" {
		writeError(response, &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Fixed CI verifier identity is server-owned"})
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxBodyBytes))
	if err != nil {
		writeError(response, &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Invalid command"})
		return
	}
	input, err := target.DecodeFixedCIProofInput(raw)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := configuration.record(request, request.PathValue("workspaceId"), request.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeError(response, target.AsError(err))
		return
	}
	writeJSON(response, lifecycleStatus(result), result)
}
