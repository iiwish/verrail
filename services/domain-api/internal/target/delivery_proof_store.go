package target

import (
	"context"

	"github.com/jackc/pgx/v5"
)

const DeliveryProofVerifierVersion = "verrail-closed-delivery-verifier.v1"
const deliveryProofPrincipalID = "verrail-closed-delivery-verifier"
const deliveryProofCommand = "verrail.delivery_proof.record.v1"

type deliveryProofAuthority struct{ ciReference string }

type DeliveryProofVerifier struct {
	store   *Store
	profile DeliveryProofTrustProfile
}

func NewDeliveryProofVerifier(store *Store, profile DeliveryProofTrustProfile) (*DeliveryProofVerifier, error) {
	if err := profile.validate(); err != nil {
		return nil, err
	}
	return &DeliveryProofVerifier{store: store, profile: profile}, nil
}

func (verifier *DeliveryProofVerifier) Record(ctx context.Context, workspaceID, key string, envelope DeliveryProofEnvelope) (AgentLifecycleResult, error) {
	if verifier == nil || verifier.store == nil {
		return AgentLifecycleResult{}, forbidden("DELIVERY_PROOF_DISABLED", "Delivery proof is not configured")
	}
	payload, err := verifyDeliveryProofEnvelope(verifier.profile, workspaceID, key, envelope)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	meta := agentCommandMeta{WorkspaceID: workspaceID, Principal: Principal{Type: "service", ID: deliveryProofPrincipalID}, CommandType: deliveryProofCommand,
		IdempotencyKey: key, RequestHash: proofHash(envelope)}
	var command AgentLifecycleCommand[RecordIntegrationRunInput]
	var proof *validatedCriterionProof
	tx, replay, err := verifier.store.beginLifecycleCommandWithAdmission(ctx, meta, true, func(tx pgx.Tx) error {
		if _, err := verifyDeliveryProofEnvelope(verifier.profile, workspaceID, key, envelope); err != nil {
			return err
		}
		ci := &FixedCIProofVerifier{store: verifier.store, profile: verifier.profile.CI}
		var err error
		command, proof, err = ci.admitForRequirement(ctx, tx, meta, payload.Source, payload.Kind)
		if err != nil {
			return err
		}
		ciReference := command.Input.Reference
		coverage := command.Input.ProviderReceipt["criterionProof"].(map[string]any)
		coverage["providerRunId"], coverage["providerAttempt"], coverage["verifiedAt"] = payload.ObservationID, 1, payload.VerifiedAt
		command.Input.Provider, command.Input.ConnectorVersion = "verrail", DeliveryProofVerifierVersion
		command.Input.ExternalRef = "verrail-proof:" + payload.ObservationID
		command.Input.Reference = command.Input.ExternalRef
		command.Input.EnvironmentRef = "verrail:" + verifier.profile.RuntimeManifestSHA256
		command.Input.ProviderReceipt = map[string]any{"kind": "verrail.closed-delivery-proof", "schemaVersion": 1,
			"verifierVersion": DeliveryProofVerifierVersion, "trustProfile": verifier.profile, "input": payload,
			"envelope": envelope, "criterionProof": coverage}
		proof, err = validateIntegrationProof(ctx, tx, command)
		if err != nil {
			return err
		}
		proof.deliveryVerifier = &deliveryProofAuthority{ciReference: ciReference}
		return nil
	})
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return verifier.store.recordIntegrationRun(ctx, tx, command, proof)
}
