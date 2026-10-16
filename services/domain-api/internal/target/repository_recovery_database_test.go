package target

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRepositoryRecoveryDrizzleRowSerialization(t *testing.T) {
	raw := json.RawMessage(`{
      "id":"event", "workspace_id":"workspace", "run_id":"run", "run_attempt_id":"attempt",
      "cursor":3,"fencing_token":2,"event_type":"heartbeat",
      "payload":{"raw_key":"preserved","nested_at":"not a database timestamp","value":0.125},
      "content_hash":"hash","emitted_at":"2026-10-16T13:30:00.123999+09:00",
      "received_at":"2026-10-16T04:30:01+00:00"
    }`)
	row, err := recoveryDrizzleRow("verrail_run_events", raw)
	require.NoError(t, err)
	encoded, err := json.Marshal(row)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"event","workspaceId":"workspace","runId":"run","runAttemptId":"attempt","cursor":3,"fencingToken":2,"eventType":"heartbeat","payload":{"raw_key":"preserved","nested_at":"not a database timestamp","value":0.125},"contentHash":"hash","emittedAt":"2026-10-16T04:30:00.123Z","receivedAt":"2026-10-16T04:30:01.000Z"}`, string(encoded))
	for name, mutate := range map[string]func(map[string]any){
		"unknown column":       func(row map[string]any) { row["extra"] = true },
		"missing column":       func(row map[string]any) { delete(row, "content_hash") },
		"renamed column":       func(row map[string]any) { row["runId"] = row["run_id"]; delete(row, "run_id") },
		"invalid timestamp":    func(row map[string]any) { row["received_at"] = "not-a-date" },
		"wrong timestamp type": func(row map[string]any) { row["received_at"] = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			var value map[string]any
			require.NoError(t, json.Unmarshal(raw, &value))
			mutate(value)
			changed, err := json.Marshal(value)
			require.NoError(t, err)
			_, err = recoveryDrizzleRow("verrail_run_events", changed)
			require.Error(t, err)
		})
	}
	_, err = recoveryDrizzleRow("arbitrary_table", raw)
	require.Error(t, err)
}

func TestRepositoryRecoveryActualTypeScriptStateHash(t *testing.T) {
	raw, err := os.ReadFile("testdata/repository-recovery-state-hash-v1.json")
	require.NoError(t, err)
	var vector struct {
		Synthetic bool `json:"synthetic"`
		Cases     []struct {
			Name   string          `json:"name"`
			Value  json.RawMessage `json:"value"`
			SHA256 string          `json:"sha256"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &vector))
	require.True(t, vector.Synthetic)
	require.GreaterOrEqual(t, len(vector.Cases), 8)
	for _, fixture := range vector.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			decoder := json.NewDecoder(bytes.NewReader(fixture.Value))
			decoder.UseNumber()
			var value any
			require.NoError(t, decoder.Decode(&value))
			digest, err := recoveryDatabaseDigest(value)
			require.NoError(t, err)
			require.Equal(t, fixture.SHA256, digest)
		})
	}
	_, err = recoveryDatabaseDigest(json.Number("1e400"))
	require.Error(t, err)
	_, err = recoveryDatabaseDigest(strings.Repeat("a", 16*1024*1024))
	require.Error(t, err)
}
