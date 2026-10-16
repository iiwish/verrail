package httpapi

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/verrail/verrail/services/domain-api/internal/target"
)

type DeliveryProofConfiguration struct{ verifier *target.DeliveryProofVerifier }

func ConfigureDeliveryProof(profileJSON string, store *target.Store) (*DeliveryProofConfiguration, error) {
	if profileJSON == "" {
		return nil, nil
	}
	profile, err := target.ParseDeliveryProofTrustProfile(profileJSON)
	if err != nil {
		return nil, err
	}
	verifier, err := target.NewDeliveryProofVerifier(store, profile)
	if err != nil {
		return nil, err
	}
	return &DeliveryProofConfiguration{verifier: verifier}, nil
}

// The signed envelope is this endpoint's credential. A normal domain bearer or
// caller-provided Principal never supplies independent verifier authority.
func NewWithProofVerifiers(token string, store *target.Store, logger *slog.Logger, ci *FixedCIProofConfiguration, delivery *DeliveryProofConfiguration) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", NewWithFixedCIProof(token, store, logger, ci))
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/delivery-proofs", func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		if delivery == nil {
			writeError(response, &target.Error{Status: 401, Code: "DELIVERY_PROOF_DISABLED", Message: "Delivery proof is not configured"})
			return
		}
		if request.Header.Get("X-Verrail-Principal-Type") != "" || request.Header.Get("X-Verrail-Principal-Id") != "" {
			writeError(response, &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Delivery verifier identity is server-owned"})
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(response, request.Body, 65536))
		if err != nil {
			writeError(response, &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Invalid delivery proof envelope"})
			return
		}
		envelope, err := target.DecodeDeliveryProofEnvelope(raw)
		if err != nil {
			writeError(response, target.AsError(err))
			return
		}
		result, err := delivery.verifier.Record(request.Context(), request.PathValue("workspaceId"), request.Header.Get("Idempotency-Key"), envelope)
		if err != nil {
			writeError(response, target.AsError(err))
			return
		}
		writeJSON(response, lifecycleStatus(result), result)
	})
	return mux
}
