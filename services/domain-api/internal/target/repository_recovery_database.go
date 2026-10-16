package target

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

// These are the complete Drizzle row shapes hashed by the private reader. Schema
// drift fails closed; JSON payload keys are not renamed or treated as timestamps.
var recoveryRowColumns = map[string]string{
	"verrail_run_attempts":               "id workspace_id run_id attempt_number deployment_revision_id agent_version_id runtime_profile executor_principal_type executor_principal_id fencing_token status last_event_cursor error_code error_message result idempotency_key started_at finished_at created_at updated_at",
	"verrail_execution_leases":           "id workspace_id run_id run_attempt_id executor_principal_id runtime_profile fencing_token status expires_at grace_expires_at claimed_at last_heartbeat_at released_at created_at updated_at",
	"verrail_runs":                       "id workspace_id target_id target_revision_id graph_revision_id work_node_id kind status actor_principal_type actor_principal_id actor_display_name deployment_revision_id agent_version_id attempt_count cancel_requested_at idempotency_key started_at finished_at created_at updated_at",
	"verrail_run_events":                 "id workspace_id run_id run_attempt_id cursor fencing_token event_type payload content_hash emitted_at received_at",
	"verrail_execution_command_receipts": "id workspace_id principal_type principal_id command_type idempotency_key request_hash response created_at",
	"verrail_audit_events":               "id workspace_id principal_type principal_id event_type aggregate_type aggregate_id idempotency_key payload occurred_at",
	"verrail_artifacts":                  "id workspace_id target_id kind title created_by_principal_type created_by_principal_id created_at updated_at",
	"verrail_artifact_revisions":         "id workspace_id artifact_id revision_number content_hash content_ref source_run_id source_work_node_id base_revision_id created_by_principal_type created_by_principal_id created_at",
}

func recoveryDrizzleRow(table string, raw json.RawMessage) (map[string]any, error) {
	columns, known := recoveryRowColumns[table]
	if !known {
		return nil, fixedCIProofMismatch()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var stored map[string]any
	if decoder.Decode(&stored) != nil || len(stored) != len(strings.Fields(columns)) {
		return nil, fixedCIProofMismatch()
	}
	result := make(map[string]any, len(stored))
	for _, column := range strings.Fields(columns) {
		value, exists := stored[column]
		if !exists {
			return nil, fixedCIProofMismatch()
		}
		parts := strings.Split(column, "_")
		name := parts[0]
		for _, part := range parts[1:] {
			name += strings.ToUpper(part[:1]) + part[1:]
		}
		if value != nil && strings.HasSuffix(column, "_at") {
			text, ok := value.(string)
			if !ok {
				return nil, fixedCIProofMismatch()
			}
			parsed, err := time.Parse(time.RFC3339Nano, text)
			if err != nil {
				return nil, fixedCIProofMismatch()
			}
			value = parsed.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		}
		result[name] = value
	}
	return result, nil
}

func recoveryDatabaseDigest(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var normalized any
	if err := decoder.Decode(&normalized); err != nil {
		return "", err
	}
	hash := sha256.New()
	_, _ = hash.Write([]byte("verrail.repository-recovery-db-state.v1\x00"))
	size := 0
	write := func(data []byte) error {
		size += len(data)
		if size > 16*1024*1024 {
			return fixedCIProofMismatch()
		}
		_, err := hash.Write(data)
		return err
	}
	count := func(value int) error {
		if value < 0 || value > 16*1024*1024 {
			return fixedCIProofMismatch()
		}
		var data [4]byte
		binary.BigEndian.PutUint32(data[:], uint32(value))
		return write(data[:])
	}
	var encode func(any) error
	encode = func(value any) error {
		switch value := value.(type) {
		case nil:
			return write([]byte("n"))
		case bool:
			if value {
				return write([]byte("t"))
			}
			return write([]byte("f"))
		case json.Number:
			number, err := value.Float64()
			if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
				return fixedCIProofMismatch()
			}
			if number == 0 {
				number = 0
			}
			if err := write([]byte("d")); err != nil {
				return err
			}
			var data [8]byte
			binary.BigEndian.PutUint64(data[:], math.Float64bits(number))
			return write(data[:])
		case string:
			if err := write([]byte("s")); err != nil {
				return err
			}
			if err := count(len([]byte(value))); err != nil {
				return err
			}
			return write([]byte(value))
		case []any:
			if err := write([]byte("a")); err != nil {
				return err
			}
			if err := count(len(value)); err != nil {
				return err
			}
			for _, item := range value {
				if err := encode(item); err != nil {
					return err
				}
			}
			return nil
		case map[string]any:
			keys := make([]string, 0, len(value))
			for key := range value {
				keys = append(keys, key)
			}
			sort.Slice(keys, func(i, j int) bool {
				left, right := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
				for index := 0; index < len(left) && index < len(right); index++ {
					if left[index] != right[index] {
						return left[index] < right[index]
					}
				}
				return len(left) < len(right)
			})
			if err := write([]byte("o")); err != nil {
				return err
			}
			if err := count(len(keys)); err != nil {
				return err
			}
			for _, key := range keys {
				if err := encode(key); err != nil {
					return err
				}
				if err := encode(value[key]); err != nil {
					return err
				}
			}
			return nil
		default:
			return fixedCIProofMismatch()
		}
	}
	if err := encode(normalized); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func readRecoveryDatabaseRow(ctx context.Context, tx pgx.Tx, table, workspaceID, id string) (map[string]any, error) {
	if _, known := recoveryRowColumns[table]; !known {
		return nil, fixedCIProofMismatch()
	}
	var raw json.RawMessage
	// Table names come only from the fixed schema allowlist above.
	if err := tx.QueryRow(ctx, `select to_jsonb(record) from `+table+` record where workspace_id=$1 and id=$2`, workspaceID, id).Scan(&raw); err != nil {
		if err == pgx.ErrNoRows {
			return nil, fixedCIProofMismatch()
		}
		return nil, err
	}
	return recoveryDrizzleRow(table, raw)
}

func readRecoveryDatabaseEvents(ctx context.Context, tx pgx.Tx, workspaceID, runID, attemptID string) ([]any, error) {
	rows, err := tx.Query(ctx, `select to_jsonb(event) from verrail_run_events event where workspace_id=$1 and run_id=$2 and run_attempt_id=$3 order by cursor limit 4097`, workspaceID, runID, attemptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []any{}
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		event, err := recoveryDrizzleRow("verrail_run_events", raw)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	if len(events) < 2 || len(events) > 4096 {
		return nil, fixedCIProofMismatch()
	}
	return events, rows.Err()
}

func readRecoveryDatabaseArtifacts(ctx context.Context, tx pgx.Tx, workspaceID, runID string) ([]any, error) {
	rows, err := tx.Query(ctx, `select to_jsonb(revision),to_jsonb(artifact) from verrail_artifact_revisions revision
		left join verrail_artifacts artifact on artifact.id=revision.artifact_id
		where revision.workspace_id=$1 and revision.source_run_id=$2 order by revision.id limit 11`, workspaceID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	artifacts := []any{}
	for rows.Next() {
		var revisionRaw, artifactRaw json.RawMessage
		if err := rows.Scan(&revisionRaw, &artifactRaw); err != nil {
			return nil, err
		}
		revision, err := recoveryDrizzleRow("verrail_artifact_revisions", revisionRaw)
		if err != nil {
			return nil, err
		}
		artifact, err := recoveryDrizzleRow("verrail_artifacts", artifactRaw)
		if err != nil {
			return nil, err
		}
		artifacts = append(artifacts, map[string]any{"revision": revision, "artifact": artifact})
	}
	if len(artifacts) < 1 || len(artifacts) > 10 {
		return nil, fixedCIProofMismatch()
	}
	return artifacts, rows.Err()
}

func validateRecoveryDatabaseFingerprints(ctx context.Context, tx pgx.Tx, proof repositoryRecoveryProof) error {
	p, identity := proof.Probes, proof.Identity
	for _, row := range []struct{ table, id, digest string }{
		{"verrail_run_attempts", p.OldAttemptID, p.OldAttemptSHA256},
		{"verrail_execution_leases", p.OldLeaseID, p.OldLeaseSHA256},
		{"verrail_run_attempts", identity.RunAttemptID, p.CurrentAttemptSHA256},
		{"verrail_execution_leases", identity.LeaseID, p.CurrentLeaseSHA256},
		{"verrail_runs", identity.RunID, p.CurrentRunSHA256},
		{"verrail_execution_command_receipts", p.Stale.ReceiptID, p.Stale.ReceiptSHA256},
		{"verrail_audit_events", p.Stale.AuditID, p.Stale.AuditSHA256},
	} {
		actual, err := readRecoveryDatabaseRow(ctx, tx, row.table, identity.WorkspaceID, row.id)
		if err != nil {
			return err
		}
		digest, err := recoveryDatabaseDigest(actual)
		if err != nil || digest != row.digest {
			return fixedCIProofMismatch()
		}
		if row.table == "verrail_run_attempts" && row.id == identity.RunAttemptID {
			result, err := recoveryDatabaseDigest(actual["result"])
			if err != nil || result != proof.After.AuthoritativeResultSHA256 {
				return fixedCIProofMismatch()
			}
		}
	}
	for _, attempt := range []struct{ id, digest string }{{p.OldAttemptID, p.OldEventsSHA256}, {identity.RunAttemptID, proof.After.EventsSHA256}} {
		events, err := readRecoveryDatabaseEvents(ctx, tx, identity.WorkspaceID, identity.RunID, attempt.id)
		if err != nil {
			return err
		}
		digest, err := recoveryDatabaseDigest(events)
		if err != nil || digest != attempt.digest {
			return fixedCIProofMismatch()
		}
	}
	artifacts, err := readRecoveryDatabaseArtifacts(ctx, tx, identity.WorkspaceID, identity.RunID)
	if err != nil {
		return err
	}
	digest, err := recoveryDatabaseDigest(artifacts)
	if err != nil || digest != proof.After.ArtifactsSHA256 {
		return fixedCIProofMismatch()
	}
	return nil
}
